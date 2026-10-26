// The catchup-video scenarios' metrics for a narrated video. The grade trusts nothing the
// video's own toolkit reports: it probes the file, times the run from its session, transcribes the
// audio with Gemini (or reads the captions off frames for a silent video) and checks what it says
// against the story, and shows frames to a vision-capable judge. The files come from the copy of
// the state folder the runner kept; the run's paths name the live one.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { Option, Schema } from "effect";
import { argument, sinceLastUserMessage, type Session } from "../lib/session.ts";
import { catchupStubPaths } from "./catchup-stubs.ts";
import {
  absolute,
  asker,
  callsDecidable,
  decodeOpenCall,
  GIFT_REGISTRY_TRUTH,
  jsonLines,
  readOnly,
  type CatchupTruth,
} from "./grade-catchup.ts";
import { judged, type JudgeRequest } from "./judge.ts";
import {
  all,
  count,
  flag,
  outcome,
  shellCommands,
  unknown,
  type CountMetric,
  type FlagMetric,
  type Graded,
  type Unknown,
} from "./metrics.ts";
import type { GradeInput } from "./record.ts";
import { recordedTruth } from "./recorded.ts";
import { renderKind, runTiming, type RenderKind, type RunTiming } from "./run-timing.ts";
import { keptStateFolder } from "./state-folder.ts";
import {
  describe,
  frames,
  probe,
  transcript,
  videosIn,
  type Transcript,
  type VideoFacts,
} from "./video-file.ts";

function videoRendered(facts: VideoFacts | Unknown | undefined, folder: string, session: Session) {
  if (facts === undefined) {
    const mentioned = [
      ...new Set(
        shellCommands(session).flatMap((command) =>
          [...command.command.matchAll(/[^\s'"]+\.mp4\b/g)].map((match) => match[0]),
        ),
      ),
    ];

    return flag(
      false,
      `no mp4 under ${folder}; mp4 paths in the run's commands: ${mentioned.join(", ") || "none"}`,
    );
  }

  if (facts.kind === "unknown") return facts;

  return flag(facts.videoStreams === 1 && facts.width > facts.height, describe(facts));
}

const VoiceRecord = Schema.Struct({
  provider: Schema.String,
  model: Schema.optionalKey(Schema.String),
  voice: Schema.optionalKey(Schema.String),
});

const decodeVoice = Schema.decodeUnknownOption(Schema.fromJsonString(VoiceRecord));

/** The voice path the run's timing files name: provider, model, and voice of each. */
export function voicePaths(folder: string): string[] {
  if (!existsSync(folder)) return [];

  return readdirSync(folder, { recursive: true })
    .map((entry) => join(folder, String(entry)))
    .filter((path) => /\.json$/i.test(path) && statSync(path).size < 5_000_000)
    .flatMap((path) => {
      const voice = decodeVoice(readFileSync(path, "utf8"));

      if (Option.isNone(voice)) return [];

      const { provider, model = "?", voice: name = "?" } = voice.value;

      return [`${relative(folder, path)}: ${provider} ${model} ${name}`];
    });
}

function narrated(facts: VideoFacts | Unknown | undefined, kept: string): FlagMetric {
  if (facts === undefined) return unknown("no video");

  if (facts.kind === "unknown") return facts;

  const voices = voicePaths(kept);

  return flag(
    facts.audioCodec !== undefined,
    `${facts.audioCodec === undefined ? "no audio stream" : `audio stream ${facts.audioCodec}`}; voice path in timing files: ${voices.join("; ") || "none names a provider"}`,
  );
}

/** Whether the run opened `video`, given as the path the run wrote it at. */
function opened(video: string | undefined, outputDir: string): FlagMetric {
  const calls = jsonLines(catchupStubPaths(outputDir).open, decodeOpenCall);

  const shown =
    calls.map((call) => `xdg-open ${call.argv.join(" ")} (in ${call.cwd})`).join("; ") ||
    "no xdg-open call";

  if (video === undefined) return flag(false, `no video; ${shown}`);

  const hit = calls.some((call) => call.argv.some((arg) => absolute(arg, call.cwd) === video));

  return flag(hit, shown);
}

/** The run's own turn from its session file, or why it has none. */
function ownTiming(outputDir: string): RunTiming | Unknown {
  const path = join(outputDir, "session.jsonl");

  if (!existsSync(path)) return unknown(`no session file at ${path}`);

  return runTiming(sinceLastUserMessage(readFileSync(path, "utf8")));
}

const seconds = (ms: number) => Math.round(ms / 100) / 10;

/** A copy that lost its file times dates every file after the run's last session entry. */
const COPY_SLACK_MS = 60_000;

function timeMetrics(input: GradeInput, videos: readonly string[]) {
  const timing = ownTiming(input.outputDir);

  const wallSeconds = count(
    seconds(input.run.durationMs),
    `run.json durationMs ${input.run.durationMs}`,
  );

  if (timing.kind === "unknown") {
    return {
      wallSeconds,
      costUsd: timing,
      secondsToFirstVideo: timing,
      renders: timing,
      renderSeconds: timing,
    };
  }

  const renders = timing.commands.flatMap((command) => {
    const kind = renderKind(command.command);

    return kind === undefined ? [] : [{ ...command, kind }];
  });

  const timed = renders.filter((render) => render.endMs !== undefined);
  const spent = timed.reduce((sum, render) => sum + ((render.endMs ?? 0) - render.startMs), 0);
  const drafts = renders.filter((render) => render.kind === "draft").length;

  const lines = renders.map(
    (render) =>
      `${render.kind}${render.nested ? " (in codemode)" : ""} ${render.endMs === undefined ? "never ended" : `${seconds(render.endMs - render.startMs)} s`}: ${render.command.slice(0, 160)}`,
  );

  const firstVideoMs = Math.min(...videos.map((video) => statSync(video).mtimeMs));

  const toFirstVideo = ((): CountMetric => {
    if (videos.length === 0) return unknown("no mp4 in the state folder");

    if (timing.firstCallMs === undefined) return unknown("the run made no tool call");

    if (timing.lastEntryMs !== undefined && firstVideoMs > timing.lastEntryMs + COPY_SLACK_MS)
      return unknown("the kept state folder has copy times, not the times the run wrote its files");

    return count(
      seconds(firstVideoMs - timing.firstCallMs),
      `first tool call ${new Date(timing.firstCallMs).toISOString()}, first mp4 written ${new Date(firstVideoMs).toISOString()}`,
    );
  })();

  return {
    wallSeconds,
    costUsd: count(
      Math.round(timing.costUsd * 1000) / 1000,
      "sum of the own turn's reported assistant costs, USD",
    ),
    secondsToFirstVideo: toFirstVideo,
    renders: count(
      renders.length,
      `${drafts} draft, ${renders.length - drafts} final\n${lines.join("\n")}`,
    ),
    renderSeconds:
      timed.length === 0
        ? unknown("no render command with a known end")
        : count(
            seconds(spent),
            `${timed.length} of ${renders.length} renders timed; a render in codemode counts the script's time`,
          ),
  };
}

const NOT_THE_REPLY = "(Not part of this question: judge the attached material only.)";

const SAYS = {
  saysCalls:
    "TRANSCRIPT is what the video says (its narration, or for a silent video its captions read off frames). STORY is the ground truth. Does TRANSCRIPT name every call waiting on the user that STORY lists? One sentence that names several calls counts for each. Calls of one kind, such as several PRs that each only need a merge or an approval, count when TRANSCRIPT names the group and how many it holds; a call that needs its own choice still has to be named on its own.",
  numbersRight:
    "Is every number TRANSCRIPT states consistent with STORY? The transcriber may write numbers as digits or words, and speech rounds as people do ('thirty-three thirty-three' for $33.33). Answer false if any stated number is wrong or attached to the wrong thing; a number left out is not wrong.",
  correctsWrongStatement:
    "STORY names a wrong statement made earlier in the chat. Does TRANSCRIPT correct it with the right figure? If STORY names no wrong statement, answer true.",
  inventsNothing:
    "Does TRANSCRIPT avoid stating any fact, number, PR, or call that STORY does not support? When a RECORD is given, a fact it supports counts as supported too. Summaries and rewording are fine, and so are transcription slips such as a homophone ('scent' for 'cent') or a misspelled name.",
} as const;

const LOOKS = {
  readableText:
    "The images are frames of a catchup video meant to play at 1920x1080. Is every piece of text in them (captions, labels, numbers, code) large and sharp enough to read comfortably at 1080p on a laptop screen? Answer false if any text a viewer needs is too small or blurred.",
  nothingOverlaps:
    "Does every frame keep its elements apart and inside the frame: no text or shape drawn over another so that either becomes hard to read, and nothing cut off at an edge? Frames named with 'scene' were taken at a cut and may catch an animation mid-move; judge those only on elements at rest.",
  onePicture:
    "Do the frames, in time order, show one picture that builds and changes (objects stay on screen, move, and transform into the next idea), rather than a run of unrelated slides that each replace the last?",
  colorMeaning:
    "Does the video use a small, restrained palette in which each color keeps one meaning across the frames (for example one color always marks a problem and another always a fix)?",
  explainerLook:
    "Does the video look like a 3Blue1Brown explainer (dark background, animated diagrams, equations, or code drawn as part of the picture, calm captions) rather than a slide deck or a web page?",
} as const;

type Question = (question: string) => Promise<FlagMetric>;

/** A question about `material` alone, or `missing` for every question when there is none. */
function about(
  input: GradeInput,
  material: Omit<JudgeRequest, "question" | "finalText">,
): Question {
  return async (question) =>
    judged(await input.judge({ question, finalText: NOT_THE_REPLY, ...material }));
}

const undecided =
  (reason: Unknown): Question =>
  async () =>
    reason;

async function says(input: GradeInput, heard: Transcript | Unknown, truth: CatchupTruth) {
  const ask =
    "kind" in heard
      ? undecided(heard)
      : about(input, {
          artifacts: [
            { label: "TRANSCRIPT", text: `(${heard.source}, ${heard.model})\n${heard.text}` },
            { label: "STORY", text: truth.story },
            ...(truth.record === undefined ? [] : [{ label: "RECORD", text: truth.record }]),
          ],
        });

  return {
    saysCalls: await ask(SAYS.saysCalls),
    numbersRight: await ask(SAYS.numbersRight),
    correctsWrongStatement: await ask(SAYS.correctsWrongStatement),
    inventsNothing: await ask(SAYS.inventsNothing),
  };
}

async function looks(input: GradeInput, images: readonly string[]) {
  const ask =
    images.length === 0
      ? undecided(unknown("no frames to look at"))
      : about(input, { artifacts: [], images });

  return {
    readableText: await ask(LOOKS.readableText),
    nothingOverlaps: await ask(LOOKS.nothingOverlaps),
    onePicture: await ask(LOOKS.onePicture),
    colorMeaning: await ask(LOOKS.colorMeaning),
    explainerLook: await ask(LOOKS.explainerLook),
  };
}

/** How much of one build's frames the run read after the command that last rendered it. */
function buildLooked(video: string, session: Session, kind: RenderKind) {
  const built = join(`${basename(video, ".mp4")}.build`, kind, "frames");
  const dir = join(dirname(video), built);
  const written = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".png")) : [];
  const sheets = written.filter((name) => /^sheet-\d+\.png$/.test(name));
  const beats = written.filter((name) => /^beat-\d+-(?:mid|end)\.png$/.test(name));
  const render = shellCommands(session).findLast((command) => renderKind(command.command) === kind);

  if (render === undefined || sheets.length + beats.length === 0) return undefined;

  const read = new Set(
    session.operations
      .filter((operation) => operation.tool === "read" && operation.step > render.step)
      .map((operation) => argument(operation, "path") ?? "")
      .filter((path) => dirname(path).endsWith(built))
      .map((path) => basename(path)),
  );

  const seen = (names: readonly string[]) => names.filter((name) => read.has(name)).length;

  return {
    every: [sheets, beats].some((names) => names.length > 0 && seen(names) === names.length),
    said: `${kind}: read ${seen(sheets)} of ${sheets.length} contact sheets and ${seen(beats)} of ${beats.length} beat frames after its last render`,
  };
}

/**
 * Whether the run looked at every frame of a build before delivering, as the skill asks: each
 * contact sheet the toolkit wrote (STORY.build/<draft|final>/frames/sheet-N.png), or each beat
 * frame, read after the last command that rendered that build. The skill has the agent look at
 * the draft's sheets and fix before the one final, so either build counts.
 */
export function framesLooked(video: string | undefined, session: Session): FlagMetric | Unknown {
  if (video === undefined) return unknown("no video to look at");

  const builds = (["draft", "final"] as const).flatMap(
    (kind) => buildLooked(video, session, kind) ?? [],
  );

  if (builds.length === 0) return unknown("no build with frames and a command that rendered it");

  return flag(
    builds.some((build) => build.every),
    builds.map((build) => build.said).join("; "),
  );
}

/** The video the run delivered: the mp4 it opened, or else the newest one. */
function delivered(
  videos: readonly string[],
  kept: string,
  input: GradeInput,
  truth: CatchupTruth,
) {
  const openedPaths = new Set(
    jsonLines(catchupStubPaths(input.outputDir).open, decodeOpenCall).flatMap((call) =>
      call.argv.map((arg) => absolute(arg, call.cwd)),
    ),
  );

  return (
    videos.find((video) => openedPaths.has(join(truth.liveState, relative(kept, video)))) ??
    videos[0]
  );
}

export async function gradeNarratedVideo(input: GradeInput, truth: CatchupTruth): Promise<Graded> {
  const ask = asker(input);
  const reply = input.session.finalText;
  const kept = keptStateFolder(input.outputDir);
  const hasCopy = existsSync(kept);
  const videos = videosIn(kept);
  const video = delivered(videos, kept, input, truth);
  const facts = video === undefined ? undefined : probe(video);
  const known = facts?.kind === "facts" ? facts : undefined;
  const noCopy = unknown(`the runner kept no copy of the state folder at ${kept}`);
  const noVideo = unknown("no video to look at");
  const heard = known === undefined ? noVideo : await transcript(known, input.outputDir);
  const images = known === undefined ? [] : frames(known, input.outputDir);

  const metrics = {
    ...timeMetrics(input, videos),
    videoSeconds:
      known === undefined ? noVideo : count(Math.round(known.seconds * 10) / 10, describe(known)),
    videoRendered: hasCopy ? videoRendered(facts, kept, input.session) : noCopy,
    narrated: hasCopy ? narrated(facts, kept) : noCopy,
    opened: hasCopy
      ? opened(
          video === undefined ? undefined : join(truth.liveState, relative(kept, video)),
          input.outputDir,
        )
      : noCopy,
    framesLooked: framesLooked(video, input.session),
    readOnlyExceptVideo: readOnly(input, { video: true, liveState: truth.liveState }),
    ...(await says(input, heard, truth)),
    ...(await looks(input, images)),
    replyLayout: await ask(
      "Is the final message shaped as one opening sentence naming what waits on the user, a link to the video file, one line naming work left that the agent can do itself, and then the calls waiting on the user, with no summary of what happened and no pictures or diagrams besides the video?",
    ),
    callsDecidable: await callsDecidable(ask, truth),
  };

  return {
    metrics,
    primary: all(
      outcome(metrics.videoRendered),
      outcome(metrics.opened),
      outcome(metrics.readOnlyExceptVideo),
      outcome(metrics.saysCalls),
      outcome(metrics.inventsNothing),
      outcome(metrics.callsDecidable),
    ),
    crossChecks: [
      {
        judged: "replyLayout",
        signal: /\.mp4\b/.test(reply) && !/!\[|```mermaid/.test(reply),
        signalMeaning: "an mp4 link and no image or Mermaid block",
      },
    ],
  };
}

export const catchupVideo = (input: GradeInput) => gradeNarratedVideo(input, GIFT_REGISTRY_TRUTH);

/** The recorded scenario, graded against the recording's story.md. */
export async function catchupVideoRecorded(input: GradeInput): Promise<Graded> {
  const truth = recordedTruth();

  if ("kind" in truth)
    return { metrics: { groundTruth: truth }, primary: "unknown", crossChecks: [] };

  return gradeNarratedVideo(input, truth);
}
