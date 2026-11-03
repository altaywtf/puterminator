import type { JSONOutputFormat } from "@anthropic-ai/sdk/resources/messages/messages";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { downloadSubtitle, listSubtitles, type PutioError, PutioFailed, uploadText } from "./putio";
import { AnthropicClient, weightedTokens } from "./runner";

const TRANSLATOR = "claude-haiku-5-5";
const PRICE_SHARE = 0.05;
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

type Spend = { readonly allowed: () => boolean; readonly charge: (tokens: number) => void };

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
    if (!spend.allowed()) return yield* Effect.fail(new PutioFailed({ message: "no credits left this month", refused: true }));
    const client = yield* AnthropicClient;

    const message = yield* Effect.tryPromise({
      try: (signal) =>
        client.messages
          .stream(
            {
              model: TRANSLATOR,
              max_tokens: 32000,
              thinking: think ? { type: "adaptive" } : { type: "disabled" },
              output_config: { effort: "low", format: { type: "json_schema", schema } },
              system,
              messages: [{ role: "user", content }],
            },
            { signal },
          )
          .finalMessage(),
      catch: (e) => new PutioFailed({ message: `translation failed: ${e instanceof Error ? e.message : String(e)}`, refused: true }),
    });

    spend.charge(Math.ceil(weightedTokens(message.usage) * PRICE_SHARE));

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

const pickSource = (videoId: number, videoPath: string, spend: Spend) =>
  Effect.gen(function* () {
    const subs = yield* listSubtitles(videoId).pipe(Effect.mapError(nothingWritten));
    const english = subs.filter((x) => x.language_code === "eng" && sourceRank(x.source) < 2).toSorted((a, b) => sourceRank(a.source) - sourceRank(b.source));

    if (english.length === 0) return yield* Effect.fail(new PutioFailed({ message: "put.io has no English subtitle for this video", refused: true }));

    for (const sub of english.slice(0, MAX_CANDIDATES)) {
      const cues = parseSrt(yield* downloadSubtitle(videoId, sub.key).pipe(Effect.mapError(nothingWritten)));

      if (cues.length > 0 && (sub.source === "mkv" || (yield* belongsTo(videoPath, cues, spend)))) return cues;
    }

    return yield* Effect.fail(new PutioFailed({ message: "put.io’s English subtitles are for a different video", refused: true }));
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

const translateSentences = (sentences: ReadonlyArray<Sentence>, language: string, spend: Spend) =>
  Effect.gen(function* () {
    const reply = yield* askHaiku(
      `Translate English film and TV subtitles into ${language}. Return every sentence with its id, its English text copied exactly, and its translation. Keep line breaks, italics tags and speaker dashes. Write natural spoken ${language}, as a professional subtitler would.`,
      JSON.stringify({ sentences: sentences.map((s) => ({ id: s.id, text: sentenceText(s) })) }),
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

const translateBatch = (sentences: ReadonlyArray<Sentence>, language: string, spend: Spend) =>
  Effect.gen(function* () {
    const got = new Map<number, string>();
    let missing = sentences;

    for (let round = 0; round < ROUNDS && missing.length > 0; round++) {
      for (const [id, text] of yield* translateSentences(missing, language, spend)) got.set(id, text);
      missing = missing.filter((s) => !got.has(s.id));
    }

    if (missing.length > sentences.length * MAX_MISSING) return yield* Effect.fail(new PutioFailed({ message: `the translation skipped ${missing.length} of ${sentences.length} sentences`, refused: true }));

    return sentences.flatMap((s) => {
      const text = got.get(s.id);

      return text === undefined ? s.lines : splitAcross(text, s.lines);
    });
  });

export const translateSubtitle = (videoId: number, videoPath: string, parentId: number, name: string, language: LanguageCode, spend: Spend) =>
  Effect.gen(function* () {
    const cues = yield* pickSource(videoId, videoPath, spend);

    const translated = yield* Effect.forEach(
      toBatches(toSentences(cues)),
      (batch) => translateBatch(batch, LANGUAGES[language], spend),
      { concurrency: PARALLEL },
    ).pipe(Effect.map((batches) => batches.flat()));

    return yield* uploadText(name, parentId, toSrt(cues.map((c, id) => ({ head: c.head, text: cueText(translated[id], c.text) }))));
  });
