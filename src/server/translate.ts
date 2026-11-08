import type { JSONOutputFormat } from "@anthropic-ai/sdk/resources/messages/messages";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { nameOf } from "./changes";
import { type OpenSubtitles, parseRelease, rankCandidates } from "./opensubtitles";
import type { Facts, Tmdb } from "./tmdb";
import { downloadSubtitle, listSubtitles, mediaInfo, type PutioError, PutioFailed, uploadText } from "./putio";
import { blockedText } from "../shared/contract";
import { outOfBudget } from "./credits";
import { AnthropicClient, isSpendLimit, usageMeter } from "./runner";

const TRANSLATOR = "claude-haiku-5-5";
const BATCH = 60;
const PARALLEL = 8;

export const LanguageCode = Schema.Literals(["ara", "chi", "cze", "dan", "dut", "fin", "fre", "ger", "gre", "heb", "hin", "hun", "ind", "ita", "jpn", "kor", "nor", "pol", "por", "rum", "rus", "spa", "swe", "tha", "tur", "ukr", "vie"]);

type LanguageCode = typeof LanguageCode.Type;

export const LANGUAGES: Record<LanguageCode, string> = {
  ara: "Arabic",
  chi: "Chinese (Simplified)",
  cze: "Czech",
  dan: "Danish",
  dut: "Dutch",
  fin: "Finnish",
  fre: "French",
  ger: "German",
  gre: "Greek",
  heb: "Hebrew",
  hin: "Hindi",
  hun: "Hungarian",
  ind: "Indonesian",
  ita: "Italian",
  jpn: "Japanese",
  kor: "Korean",
  nor: "Norwegian",
  pol: "Polish",
  por: "Portuguese",
  rum: "Romanian",
  rus: "Russian",
  spa: "Spanish",
  swe: "Swedish",
  tha: "Thai",
  tur: "Turkish",
  ukr: "Ukrainian",
  vie: "Vietnamese",
};

const sourceRank = (source: string) => (source === "mkv" ? 0 : source.startsWith("opensubtitles") ? 1 : 2);

type Cue = { head: string; text: string };

type Spend = { readonly blocked: () => string | null; readonly charge: (tokens: number) => void };

const nothingWritten = (e: PutioError): PutioError => (Predicate.isTagged(e, "PutioFailed") ? new PutioFailed({ message: e.message, refused: true }) : e);

const cueText = (translated: string | undefined, original: string) => {
  const text = (translated ?? "").replace(/\r/g, "").replace(/\n{2,}/g, "\n").trim();

  return text || original;
};

const parseSrt = (srt: string): Cue[] =>
  srt
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .flatMap((block) => {
      const lines = block.split("\n");
      const timing = lines.findIndex((l) => l.includes("-->"));

      return timing < 0 ? [] : [{ head: lines.slice(0, timing + 1).join("\n"), text: lines.slice(timing + 1).join("\n") }];
    });

const toSrt = (cues: ReadonlyArray<Cue>) => `${cues.map((c) => `${c.head}\n${c.text}`).join("\n\n")}\n`;

const Translated = Schema.Struct({ id: Schema.Finite, english: Schema.String, text: Schema.String });
const decodeSentences = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ sentences: Schema.Array(Translated) })));

type Sentence = { readonly id: number; readonly lines: ReadonlyArray<string> };

const MAX_GROUP = 8;
const endsSentence = (text: string) => /[.!?…♪"”)\]]$/.test(text.replace(/<[^>]*>/g, "").trim());

const toSentences = (cues: ReadonlyArray<Cue>) => {
  const groups: Array<{ id: number; lines: string[] }> = [];

  for (const [i, cue] of cues.entries()) {
    const last = groups.at(-1);

    if (last !== undefined && last.lines.length < MAX_GROUP && !endsSentence(cues[i - 1]?.text ?? "")) last.lines.push(cue.text);
    else groups.push({ id: groups.length, lines: [cue.text] });
  }

  return groups;
};

const sentenceText = (s: Sentence) => (s.lines.length === 1 ? (s.lines[0] ?? "") : s.lines.map((l) => l.replace(/\s*\n\s*/g, " ")).join(" "));

const balanceItalics = (piece: string) => {
  const opens = piece.match(/<i>/g)?.length ?? 0;
  const closes = piece.match(/<\/i>/g)?.length ?? 0;

  return `${"<i>".repeat(Math.max(0, closes - opens))}${piece}${"</i>".repeat(Math.max(0, opens - closes))}`;
};

const splitAcross = (text: string, english: ReadonlyArray<string>): string[] => {
  if (english.length === 1) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const weights = english.map((l) => Math.max(1, l.replace(/<[^>]*>/g, "").length));
  const total = weights.reduce((a, b) => a + b, 0);
  const pieces: string[] = [];
  let start = 0;
  let seen = 0;

  for (const [i, weight] of weights.entries()) {
    seen += weight;
    const left = english.length - 1 - i;
    const end = i === english.length - 1 ? words.length : Math.min(words.length - left, Math.max(start + 1, Math.round((words.length * seen) / total)));
    const piece = words.slice(start, Math.max(start, end)).join(" ");

    pieces.push(piece || (pieces.at(-1) ?? text));
    start = Math.max(start, end);
  }

  return pieces.map(balanceItalics);
};

const toBatches = (sentences: ReadonlyArray<Sentence>) => {
  const batches: Array<{ size: number; groups: Sentence[] }> = [];

  for (const s of sentences) {
    const last = batches.at(-1);

    if (last !== undefined && last.size + s.lines.length <= BATCH) {
      last.groups.push(s);
      last.size += s.lines.length;
    } else batches.push({ size: s.lines.length, groups: [s] });
  }

  return batches.map((b) => b.groups);
};

const askHaiku = (system: string, content: string, schema: JSONOutputFormat["schema"], spend: Spend, think: boolean) =>
  Effect.gen(function* () {
    const blocked = spend.blocked();

    if (blocked !== null) return yield* Effect.fail(new PutioFailed({ message: blocked, refused: true }));
    const client = yield* AnthropicClient;
    const meter = usageMeter(spend.charge);

    const message = yield* Effect.tryPromise({
      try: (signal) => {
        const stream = client.messages.stream(
          {
            model: TRANSLATOR,
            max_tokens: 32000,
            thinking: think ? { type: "adaptive" } : { type: "disabled" },
            output_config: { effort: "low", format: { type: "json_schema", schema } },
            system,
            messages: [{ role: "user", content }],
          },
          { signal },
        );

        stream.on("streamEvent", (e, snapshot) => {
          if (e.type === "message_start" || e.type === "message_delta") meter.charge(snapshot);
        });

        const final = stream.finalMessage();

        final.catch(() => {
          const last = stream.currentMessage;

          if (last) meter.chargeStreamed(last);
        });

        return final;
      },
      catch: (e) =>
        new PutioFailed({
          message: isSpendLimit(e) ? blockedText(outOfBudget(Date.now())) : `translation failed: ${e instanceof Error ? e.message : String(e)}`,
          refused: true,
        }),
    });

    meter.charge(message);

    return { text: message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""), stop: message.stop_reason };
  });

const SAMPLE = 60;
const decodeVerdict = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ matches: Schema.Boolean })));

const belongsTo = (videoPath: string, cues: ReadonlyArray<Cue>, spend: Spend) =>
  Effect.gen(function* () {
    const start = Math.floor(cues.length / 4);
    const sample = cues.slice(start, start + SAMPLE).map((c) => c.text.replace(/\n/g, " "));

    const reply = yield* askHaiku(
      "Subtitle sites match subtitles to videos by file hash and name, and sometimes pick a different film, episode or talk. Given a video's path in someone's library and lines from a subtitle, decide whether the subtitle is for that video. Say it doesn't match only when the lines clearly belong to something else.",
      JSON.stringify({ video: videoPath, lines: sample }),
      { type: "object", properties: { matches: { type: "boolean" } }, required: ["matches"], additionalProperties: false },
      spend,
      true,
    );

    const verdict = decodeVerdict(reply.text);

    return Option.isSome(verdict) && verdict.value.matches;
  });

const MAX_CANDIDATES = 3;
const ONLINE_TRIES = 2;
const LATE_SLACK_SECONDS = 10;
const MIN_COVERAGE = 0.7;

const seconds = (stamp: string) => {
  const [h = "0", m = "0", s = "0", ms = "0"] = stamp.split(/[:,.]/);

  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
};

const lastEnd = (cues: ReadonlyArray<Cue>) => Math.max(0, ...cues.map((c) => seconds(c.head.match(/-->\s*([\d:,.]+)/)?.[1] ?? "0")));

const fitsLength = (cues: ReadonlyArray<Cue>, duration: number | null) => {
  if (duration === null) return true;
  const end = lastEnd(cues);

  return end <= duration + LATE_SLACK_SECONDS && end >= duration * MIN_COVERAGE;
};

const fromPutio = (videoId: number, videoPath: string, spend: Spend) =>
  Effect.gen(function* () {
    const subs = yield* listSubtitles(videoId).pipe(Effect.mapError(nothingWritten));
    const english = subs.filter((x) => x.language_code === "eng" && sourceRank(x.source) < 2).toSorted((a, b) => sourceRank(a.source) - sourceRank(b.source));

    if (english.length === 0) return { cues: null, why: "put.io has no English subtitle for this video" };

    for (const sub of english.slice(0, MAX_CANDIDATES)) {
      const cues = parseSrt(yield* downloadSubtitle(videoId, sub.key).pipe(Effect.mapError(nothingWritten)));

      if (cues.length > 0 && (sub.source === "mkv" || (yield* belongsTo(videoPath, cues, spend)))) return { cues, why: null };
    }

    return { cues: null, why: "put.io’s English subtitles are for a different video" };
  });

const fromOnline = (online: OpenSubtitles, videoId: number, videoPath: string, spend: Spend, fetch: boolean) =>
  Effect.gen(function* () {
    const release = parseRelease(nameOf(videoPath));

    if (release === null) return yield* Effect.fail(new PutioFailed({ message: "put.io has no English subtitle for this video, and its name doesn’t say which film or episode it is", refused: true }));
    const ranked = rankCandidates(nameOf(videoPath), yield* online.search(release));

    if (ranked.length === 0) return yield* Effect.fail(new PutioFailed({ message: "neither put.io nor OpenSubtitles has an English subtitle for this video", refused: true }));

    if (!fetch) return { cues: [], imdbId: null };
    const info = yield* mediaInfo(videoId).pipe(Effect.mapError(nothingWritten));
    const duration = info.media_info?.format?.duration ?? null;

    for (const candidate of ranked.slice(0, ONLINE_TRIES)) {
      const cues = parseSrt(yield* online.download(candidate.fileId));

      if (cues.length > 0 && fitsLength(cues, duration) && (yield* belongsTo(videoPath, cues, spend))) return { cues, imdbId: candidate.imdbId };
    }

    return yield* Effect.fail(new PutioFailed({ message: "OpenSubtitles’ English subtitles don’t fit this video’s length or story", refused: true }));
  });

const pickSource = (videoId: number, videoPath: string, spend: Spend, online: OpenSubtitles | null, fetch: boolean) =>
  Effect.gen(function* () {
    const found = yield* fromPutio(videoId, videoPath, spend);

    if (found.cues !== null) return { cues: found.cues, imdbId: null };

    if (online === null) return yield* Effect.fail(new PutioFailed({ message: found.why, refused: true }));

    return yield* fromOnline(online, videoId, videoPath, spend, fetch);
  });

const letters = (text: string) => text.replace(/<[^>]*>/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const ANCHOR = 16;

const sameSentence = (echo: string, source: string | undefined) => {
  if (source === undefined) return false;
  const a = letters(echo);
  const b = letters(source);

  return a.slice(0, ANCHOR) === b.slice(0, ANCHOR) && a.slice(-ANCHOR) === b.slice(-ANCHOR);
};

const SENTENCES_SCHEMA: JSONOutputFormat["schema"] = {
  type: "object",
  properties: {
    sentences: {
      type: "array",
      items: { type: "object", properties: { id: { type: "integer" }, english: { type: "string" }, text: { type: "string" } }, required: ["id", "english", "text"], additionalProperties: false },
    },
  },
  required: ["sentences"],
  additionalProperties: false,
};

const OVERLAP = 4;
const MAX_BRIEF_LINES = 4000;

const factsText = (facts: Facts | null) => {
  if (facts === null) return "";

  const lines = [`Title: ${facts.title}${facts.year ? ` (${facts.year})` : ""}${facts.genres.length > 0 ? `, ${facts.genres.join(", ")}` : ""}`];

  if (facts.overview) lines.push(`Synopsis: ${facts.overview}`);

  if (facts.episode) lines.push(`This episode: ${facts.episode.title}${facts.episode.overview ? `. ${facts.episode.overview}` : ""}`);

  if (facts.characters.length > 0) lines.push(`Characters, with who plays them as a hint only: ${facts.characters.map((c) => (c.played ? `${c.name} (${c.played})` : c.name)).join(", ")}`);

  return lines.join("\n");
};

const decodeNotes = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ notes: Schema.String })));

const NOTES_SCHEMA: JSONOutputFormat["schema"] = { type: "object", properties: { notes: { type: "string" } }, required: ["notes"], additionalProperties: false };

const translatorNotes = (cues: ReadonlyArray<Cue>, facts: string, language: string, spend: Spend) =>
  Effect.gen(function* () {
    const reply = yield* askHaiku(
      `You brief a subtitler who will translate English subtitles into ${language} in separate chunks. From the facts and the whole English subtitle, write short notes that keep the chunks consistent: each recurring character's gender as the dialogue shows it, not who plays them, and how others address them, who speaks formally or informally to whom in ${language}, recurring names, places and terms with how to render them, and the tone. At most 200 words.`,
      JSON.stringify({ facts, subtitle: cues.slice(0, MAX_BRIEF_LINES).map((c) => c.text.replace(/\n/g, " ")).join("\n") }),
      NOTES_SCHEMA,
      spend,
      false,
    );

    return Option.match(decodeNotes(reply.text), { onNone: () => "", onSome: (n) => n.notes.trim() });
  });

const translateSentences = (sentences: ReadonlyArray<Sentence>, language: string, spend: Spend, brief: string, before: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const reply = yield* askHaiku(
      `Translate English film and TV subtitles into ${language}. Return every sentence with its id, its English text copied exactly, and its translation. Keep line breaks, italics tags and speaker dashes. Write natural spoken ${language}, as a professional subtitler would. Lines under "before" come just before these sentences: read them for context, never return them.${brief ? `\n\nAbout this video:\n${brief}` : ""}`,
      JSON.stringify({ before, sentences: sentences.map((s) => ({ id: s.id, text: sentenceText(s) })) }),
      SENTENCES_SCHEMA,
      spend,
      false,
    );

    const out = decodeSentences(reply.text);
    const source = new Map(sentences.map((s) => [s.id, sentenceText(s)]));
    const aligned = (t: typeof Translated.Type) => t.text.trim() !== "" && sameSentence(t.english, source.get(t.id));

    return new Map(Option.isSome(out) ? out.value.sentences.filter(aligned).map((t) => [t.id, t.text] as const) : []);
  });

const ROUNDS = 2;
const MAX_MISSING = 0.05;

const translateBatch = (sentences: ReadonlyArray<Sentence>, language: string, spend: Spend, brief: string, before: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const got = new Map<number, string>();
    let missing = sentences;

    for (let round = 0; round < ROUNDS && missing.length > 0; round++) {
      for (const [id, text] of yield* translateSentences(missing, language, spend, brief, before)) got.set(id, text);
      missing = missing.filter((s) => !got.has(s.id));
    }

    if (missing.length > sentences.length * MAX_MISSING) return yield* Effect.fail(new PutioFailed({ message: `the translation skipped ${missing.length} of ${sentences.length} sentences`, refused: true }));

    return sentences.flatMap((s) => {
      const text = got.get(s.id);

      return text === undefined ? s.lines : splitAcross(text, s.lines);
    });
  });

export type Sources = { readonly online: OpenSubtitles | null; readonly tmdb: Tmdb | null };

export const checkSource = (videoId: number, videoPath: string, spend: Spend, sources: Sources) => Effect.asVoid(pickSource(videoId, videoPath, spend, sources.online, false));

export const translateSubtitle = (videoId: number, videoPath: string, parentId: number, name: string, language: LanguageCode, spend: Spend, sources: Sources) =>
  Effect.gen(function* () {
    const { cues, imdbId } = yield* pickSource(videoId, videoPath, spend, sources.online, true);
    const release = parseRelease(nameOf(videoPath));
    const facts = factsText(sources.tmdb && release ? yield* sources.tmdb.facts(release, imdbId) : null);
    const batches = toBatches(toSentences(cues));
    const notes = batches.length > 1 ? yield* translatorNotes(cues, facts, LANGUAGES[language], spend) : "";
    const brief = [facts, notes && `Translator notes: ${notes}`].filter((l) => l !== "").join("\n");

    const translated = yield* Effect.forEach(
      batches,
      (batch, i) => translateBatch(batch, LANGUAGES[language], spend, brief, (batches[i - 1] ?? []).slice(-OVERLAP).map(sentenceText)),
      { concurrency: PARALLEL },
    ).pipe(Effect.map((done) => done.flat()));

    return yield* uploadText(name, parentId, toSrt(cues.map((c, id) => ({ head: c.head, text: cueText(translated[id], c.text) }))));
  });
