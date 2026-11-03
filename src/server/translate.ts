import type { JSONOutputFormat } from "@anthropic-ai/sdk/resources/messages/messages";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { downloadSubtitle, listSubtitles, type PutioError, PutioFailed, uploadText } from "./putio";
import { AnthropicClient, weightedTokens } from "./runner";

const TRANSLATOR = "claude-haiku-5-5";
const PRICE_SHARE = 0.05;
const BATCH = 100;
const PARALLEL = 6;

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

const Group = Schema.Struct({ id: Schema.Finite, lines: Schema.Array(Schema.String) });
const decodeGroups = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ groups: Schema.Array(Group) })));

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

const GROUPS_SCHEMA: JSONOutputFormat["schema"] = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: { type: "object", properties: { id: { type: "integer" }, lines: { type: "array", items: { type: "string" } } }, required: ["id", "lines"], additionalProperties: false },
    },
  },
  required: ["groups"],
  additionalProperties: false,
};

const translateGroups = (groups: ReadonlyArray<Sentence>, language: string, spend: Spend, strict: boolean) =>
  Effect.gen(function* () {
    const reply = yield* askHaiku(
      `Translate English film and TV subtitles into ${language}. Each group is one sentence split across consecutive on-screen cues. Return every group with its id and exactly as many lines as it has, in the same order, each line non-empty and shown while the matching English line is on screen. Keep line breaks inside a line, italics tags and speaker dashes. Write natural spoken ${language}, as a professional subtitler would.`,
      JSON.stringify({ groups }),
      GROUPS_SCHEMA,
      spend,
      false,
    );

    const out = decodeGroups(reply.text);
    const english = new Map(groups.map((g) => [g.id, g.lines]));

    const whole = (g: typeof Group.Type) => {
      const source = english.get(g.id);

      if (source === undefined || g.lines.length !== source.length) return false;

      return !strict || (g.lines.every((l) => l.trim()) && g.lines.join("\n").trim() !== source.join("\n").trim());
    };

    const got = new Map(Option.isSome(out) ? out.value.groups.filter(whole).map((g) => [g.id, g.lines] as const) : []);

    return { got, why: Option.isNone(out) ? `unreadable reply, ${reply.stop}` : `${got.size} of ${groups.length} sentences back whole` };
  });

const translateLine = (line: string, language: string, spend: Spend) =>
  Effect.gen(function* () {
    const reply = yield* translateGroups([{ id: 0, lines: [line] }], language, spend, false);
    const text = reply.got.get(0)?.[0];

    if (text === undefined) return yield* Effect.fail(new PutioFailed({ message: `the translation skipped some lines (${reply.why})`, refused: true }));

    return text;
  });

const ROUNDS = 3;
const MAX_SINGLES = 20;

const translateAll = (groups: ReadonlyArray<Sentence>, language: string, spend: Spend) =>
  Effect.gen(function* () {
    const got = new Map<number, ReadonlyArray<string>>();
    let missing = groups;
    let why = "";

    for (let round = 0; round < ROUNDS && missing.length > 0; round++) {
      const reply = yield* translateGroups(missing, language, spend, true);

      for (const [id, lines] of reply.got) got.set(id, lines);
      missing = missing.filter((g) => !got.has(g.id));
      why = reply.why;
    }

    if (missing.length > MAX_SINGLES) return yield* Effect.fail(new PutioFailed({ message: `the translation skipped some lines (${why})`, refused: true }));

    for (const group of missing) {
      const whole = (yield* translateGroups([group], language, spend, false)).got.get(group.id);

      got.set(group.id, whole ?? (yield* Effect.forEach(group.lines, (line) => translateLine(line, language, spend))));
    }

    return got;
  });

export const translateSubtitle = (videoId: number, videoPath: string, parentId: number, name: string, language: LanguageCode, spend: Spend) =>
  Effect.gen(function* () {
    const cues = yield* pickSource(videoId, videoPath, spend);

    const translated = yield* Effect.forEach(
      toBatches(toSentences(cues)),
      (batch) => Effect.map(translateAll(batch, LANGUAGES[language], spend), (got) => batch.flatMap((g) => got.get(g.id) ?? g.lines)),
      { concurrency: PARALLEL },
    ).pipe(Effect.map((batches) => batches.flat()));

    return yield* uploadText(name, parentId, toSrt(cues.map((c, id) => ({ head: c.head, text: cueText(translated[id], c.text) }))));
  });
