// The data that the statechart scripts pass between them. Type stripping erases this whole file,
// so the port still runs the upstream code line for line.

import type { Inputs } from "./snapshot.ts";

// filter(Boolean) drops the falsy items, as the scripts rely on.
// includes() takes any value and is false for one that the array cannot hold, as the scripts
// rely on when they look up a status, an exit code, or an error code that may be missing.
declare global {
  interface Array<T> {
    filter(predicate: BooleanConstructor): Exclude<T, Falsy>[];
    includes(searchElement: unknown, fromIndex?: number): boolean;
  }
  interface ReadonlyArray<T> {
    filter(predicate: BooleanConstructor): Exclude<T, Falsy>[];
    includes(searchElement: unknown, fromIndex?: number): boolean;
  }
}
type Falsy = false | 0 | 0n | "" | null | undefined;

// A name that TLC printed, such as a rule. It is never empty, and the & {} keeps TypeScript
// from counting "" among its values, so that `name && x` is x or the name's null.
export type NonEmptyName = string & {};

// ---------------------------------------------------------------------------------------------
// TLA+ values and TLC's output

// A TLA+ value as lib.ts parseValue reads it from TLC's output. A sequence, a tuple, and a set
// are arrays; a record and any other function are objects.
export type TlaValue = string | number | boolean | TlaValue[] | TlaRecord;
export interface TlaRecord {
  [field: string]: TlaValue;
}

// One model state: each variable of the spec and its value.
export type Vars = TlaRecord;

// A state of TLC's state graph, as it dumps it with -dump dot,actionlabels.
export interface DotNode {
  readonly id: string;
  readonly vars: Vars;
  readonly init: boolean;
}

// A step of TLC's state graph. action is the definition that TLC names it after.
export interface DotEdge {
  readonly from: string;
  readonly to: string;
  readonly action: string;
}

// TLC's state graph. loops are the steps from a state to itself.
export interface StateGraph {
  readonly nodes: Map<string, DotNode>;
  readonly edges: DotEdge[];
  readonly loops: DotEdge[];
}

// One state of a TLC counterexample. action is null for an initial state.
export interface TraceStep {
  readonly action: string | null;
  readonly vars: Vars;
}

// One TLC counterexample: a path from a start state to a state that breaks invariant.
export interface Trace {
  readonly invariant: string;
  readonly steps: TraceStep[];
}

// A state that the rules module printed: its key and the rules it breaks.
export interface BrokenState {
  readonly key: string;
  readonly rules: string[];
}

// ---------------------------------------------------------------------------------------------
// The mapping module that the user writes (NAME.map.mjs). spec-text.ts SCAFFOLD documents it.

// What the scripts tell a mapping function about one model state.
export interface Facts {
  // The actions that the state enables, including steps that change no variable.
  readonly enabled: Set<string>;
  // True when only readerActions are enabled.
  readonly settled: boolean;
}

// The statuses that the legend names, from best to worst.
export type Status = "works" | "fixed" | "after" | "mixed" | "wrong" | "worse";

// The mapping. state() is the one export it must have. The scripts check each return value that
// they do not trust, so those are unknown.
export interface Mapping {
  state(v: Vars, facts: Facts): unknown;
  // action is null only for the start of a counterexample, which no script labels.
  step?(action: string | null, before: Vars, after: Vars): string;
  guard?(action: string | null, before: Vars, after: Vars): unknown;
  timer?(action: string | null, before: Vars, after: Vars): unknown;
  cause?(v: Vars, facts: Facts, invariant: string): unknown;
  group?(v: Vars, facts: Facts): unknown;
  detail?(v: Vars, facts: Facts): unknown;
  readonly readerActions?: readonly string[];
  readonly codeWords?: readonly string[];
  readonly regionNames?: readonly string[];
  readonly groupColors?: Readonly<Record<string, string | null | undefined>>;
  readonly legend?: Readonly<Partial<Record<Status, string>>>;
}

// ---------------------------------------------------------------------------------------------
// Mermaid charts, as lib.ts parseMermaid reads them

// A "%% when" line under a transition: the state ids of other regions that it needs.
export interface When {
  readonly not: boolean;
  readonly ids: string[];
}

// A when line resolved to the states that it names, per region.
export interface Guard {
  readonly not: boolean;
  readonly states: Record<string, string[]>;
}

// A transition as the chart writes it, between state ids. words is true when the label ended
// with words in [ ].
export interface ChartLine {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly words: boolean;
  when?: When;
}

export interface ChartLeaf {
  readonly name: string;
  readonly leaf: true;
  readonly parts?: undefined;
}

export interface ChartComposite {
  readonly name: string;
  readonly parts: ChartPart[];
  readonly leaf?: undefined;
}

// One part of a composite, which -- splits into parallel regions.
export interface ChartPart {
  readonly children: (ChartLeaf | ChartComposite)[];
  readonly transitions: ChartLine[];
}

// A transition between the full captions of two states of one region.
export interface RegionTransition {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  when?: When;
  guard?: Guard;
}

// Where a state id of a chart leads: every full caption under it, the captions that a transition
// into it lands on, and how deep in composites it is.
export interface RegionInfo {
  readonly all: string[];
  readonly initial: string[];
  readonly depth: number;
}

// Where one region goes from a state with one label, when the guard holds.
export interface Move {
  readonly to: string;
  readonly guard: Guard | undefined;
}

// One region of a chart, or the combined machine of all of them.
export interface Region {
  readonly states: Set<string>;
  readonly initial: Set<string>;
  readonly transitions: RegionTransition[];
}

// A "%% never NAME: A & B -- sentence" rule line.
export interface Never {
  readonly name: string;
  readonly states: string[];
  readonly sentence: string;
}

export interface Chart {
  readonly regions: Record<string, Region>;
  readonly nevers: Never[];
}

// One difference between two charts: what differs, and the states or transitions.
export type ChartDifference = [string, string[]];

// ---------------------------------------------------------------------------------------------
// TLA+ source, as lib.ts reads it

// Where a definition is in the source: its name at `at`, and its body from `from` to `to`.
export interface Definition {
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

// What one definition body does by itself.
export interface DirectUse {
  readonly reads: string[];
  readonly writes: string[];
  readonly acts: boolean;
  readonly calls: string[];
}

// What a definition does through every definition that it calls.
export interface Use {
  readonly reads: Set<string>;
  readonly writes: Set<string>;
  acts: boolean;
}

// A condition of an action that no comment ties to code.
export interface UncitedCondition {
  readonly line: number;
  readonly action: string;
  readonly condition: string;
}

// A rule of a module: its sentence, the variables it reads, and whether it is LOCAL.
export interface RuleEntry {
  readonly sentence: string | undefined;
  readonly reads: Set<string>;
  readonly local: boolean;
}

// The path of a variable or a record field, and the kinds of value that it has in one model.
export interface FieldShape {
  readonly path: string[];
  readonly kinds: Set<string>;
}

// A field that the other model lacks, or has with another kind of value. somewhere is true when
// the other model has it in some states.
export interface UnreadField extends FieldShape {
  readonly somewhere: boolean;
}

// The reader states that a broken PROPERTY repeats forever. stutters is true when the run stops
// in the last of them.
export interface Repeats {
  readonly states: string[];
  readonly stutters: boolean;
}

// The rules of one module file, and the names that its definitions read as variables: its
// CONSTANTS, its VARIABLES, and those of the modules that it EXTENDS.
export interface RuleModule {
  readonly rules: Map<string, RuleEntry>;
  readonly parameters: string[];
}

// What one java run of TLC printed, and how it ended.
export interface JavaRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly stopped: boolean;
  readonly overflowed: boolean;
  readonly error?: Error;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}

// Where TLC and java are.
export interface TlcTools {
  readonly jar: string;
  readonly java: string;
}

// ---------------------------------------------------------------------------------------------
// The statechart command

// The flags of every command. parseArgs sets a switch to true, a value to its text, and
// --expect-broken to the rules that its values list.
export interface Flags {
  readonly "expect-broken": Set<string>;
  readonly map?: string;
  readonly config?: string;
  readonly fixed?: string;
  readonly "fixed-config"?: string;
  readonly against?: string;
  readonly "against-config"?: string;
  readonly label?: string;
  readonly title?: string;
  readonly out?: string;
  readonly theme?: string;
  readonly module?: string;
  readonly cover?: boolean;
  readonly png?: boolean;
}

// What parseArgs reads off the command line: the help to print, or the command to run.
export type Parsed =
  | { readonly help: string; readonly command?: undefined; readonly input?: undefined; readonly flags?: undefined }
  | { readonly help?: undefined; readonly command: string; readonly input: string; readonly flags: Flags };

// Pele and resvg, and the colors to draw the PNGs in.
export interface Renderer {
  readonly lib: RendererLib;
  readonly theme: Theme;
}

// One command. Its run takes a renderer whenever renders says that the flags draw PNGs, which
// render's always do, so renderFile takes a Renderer. run is a method so that it can.
export interface Command {
  readonly values: string[];
  readonly switches: string[];
  readonly renders: (flags: Flags) => boolean | undefined;
  run(input: string, flags: Flags, renderer: Renderer | null): Promise<number> | number;
}

export type Role = "fixed" | "against";

// A spec and its config, with the config's INVARIANT and PROPERTY rules taken out.
export interface TlaModel {
  readonly spec: string;
  readonly copy: string;
  readonly cfgFile: string;
  readonly cfgWithoutRules: string;
  readonly rules: string[];
  readonly properties: string[];
}

export interface TlcOptions {
  readonly dump?: string;
  readonly module?: string;
  readonly workers?: string;
}

// What one TLC run printed: stopped when its state graph grew past what the command can read,
// or else the warning about its output.
export type TlcResult =
  | { readonly stdout: string; readonly stopped: true; readonly warning?: undefined }
  | { readonly stdout: string; readonly stopped?: undefined; readonly warning: string | null };

// Whether a rule holds, and the TLC output that says so.
export interface RuleRun {
  readonly file: string;
  readonly rule: string;
  readonly broken: boolean;
}

// A model that TLC checked.
export interface CheckedModel {
  readonly spec: string;
  readonly copy: string;
  readonly dot: string;
  readonly dotBytes: number;
  readonly stopped: true | undefined;
  readonly next: string | false | undefined;
  readonly dumpOut: string;
  readonly traces: RuleRun[];
  readonly properties: RuleRun[];
  readonly broken: boolean;
}

// The --fixed or --against model that TLC checked.
export interface OtherModel extends CheckedModel {
  readonly role: Role;
  readonly label: string | undefined;
  readonly listed: Listed | null | undefined;
}

export interface DrawInput {
  readonly now: CheckedModel;
  readonly other?: OtherModel | null;
  readonly uncited?: Record<string, UncitedCondition[]>;
  readonly map: string;
  readonly work: string;
  readonly out: string;
  readonly title: string | undefined;
  readonly comparing?: boolean;
  readonly cover?: boolean;
}

// The work folder of a run, the output folder, and the inputs that it read.
export interface Run {
  readonly work: string;
  readonly out: string;
  readonly inputs: Inputs;
}

// The flags while parseArgs reads them, by the name that the command line gives.
export type ParsedFlags = Flags & Record<string, string | boolean | Set<string> | undefined>;

// What runJava gathers while java runs.
export interface JavaOutput {
  stdout: string;
  stderr: string;
  stopped: boolean;
  overflowed: boolean;
  error?: Error;
}

// ---------------------------------------------------------------------------------------------
// The charts that tlc-to-chart.ts draws

// The arguments of tlc-to-chart.ts. listed arrives as JSON text, and the parser replaces it with
// the object.
export interface Listed {
  readonly spec: string;
  readonly breaks: Record<string, string>;
}

export interface ChartArgs {
  dot?: string;
  map?: string;
  traces: string[];
  broken?: string;
  fixedDot?: string;
  fixedTraces: string[];
  fixedRules: string[];
  fixedBroken?: string;
  againstDot?: string;
  againstTraces: string[];
  againstBroken?: string;
  againstRules: string[];
  listed?: Listed;
  label?: string;
  specs: string[];
  next: string[];
  view: string;
  highlight: number;
  pathOnly?: boolean;
  fullLabels?: boolean;
  flat?: boolean;
  loops?: boolean;
  regions?: boolean;
  proof?: string;
  regionsAll?: string;
  cover?: boolean;
  title?: string;
  out?: string;
  story?: string;
  summary?: string;
}

// The guard words of each label of an edge. "" is a step without guard words.
export type Guards = Map<string, Set<string>>;

// An arrow between two chart states, with the labels of the steps that take it.
export interface ChartEdge {
  readonly from: string;
  readonly to: string;
  readonly labels: Set<string>;
  readonly guards?: Guards;
  readonly secondOnly?: boolean;
  readonly apart?: boolean;
}

// An arrow of the quotient, which also counts how many model steps have each label.
export interface QuotientEdge extends ChartEdge {
  readonly counts: Map<string, number>;
  readonly guards: Guards;
  labels: Set<string>;
}

// TLC's state graph with each model state replaced by its chart state.
export interface Quotient {
  readonly nodes: Set<string>;
  readonly initial: Set<string>;
  readonly edges: Map<string, QuotientEdge>;
  readonly keys: Map<string, string>;
  readonly settled: Set<string>;
}

// One model as the mapping labels it.
export interface Model {
  readonly graph: StateGraph;
  readonly stateKeys: Map<string, string>;
  facts(vars: Vars): Facts;
  key(vars: Vars): string;
  customer(vars: Vars): string;
  step(action: string | null, before: Vars, after: Vars, view?: string): string | null;
  guard(action: string | null, before: Vars, after: Vars): string;
  cause(vars: Vars, invariant: string): string | null;
  group(vars: Vars): unknown;
}

// Whether a step of a bug's path stays hidden: it keeps the state label, the reader does not
// take it, and it changes no variable that the rule reads.
export type HiddenStep = (
  rule: string,
  sameLabel: boolean,
  action: string | null,
  before: Vars,
  after: Vars,
) => boolean;

// A trace's path in reader steps, with each state named by key.
export type ReaderPathOf = (
  trace: Trace,
  m: Model,
  key: (vars: Vars) => string,
  view?: string,
) => ReaderStop[];

// One stop of a bug's path in reader steps. The start has no label.
export interface ReaderStop {
  readonly key: string;
  readonly label: string | null;
  readonly guard?: string;
  readonly action?: string | null;
  readonly modelStep: number;
}

// A step of a bug's path, between two chart states.
export interface PathStep {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly guard: string | undefined;
}

// The counterexamples that break one rule with one cause, and the shortest of them.
export interface Bug {
  readonly id: string;
  readonly cause: string | null;
  readonly steps: number;
  readonly trace: Trace;
  readonly invariant: string;
  ends: Set<string>;
}

// The other model replays a bug: it starts elsewhere, ends the same, or goes another way.
export interface ReplayStart {
  readonly reason: "starts in another state";
  readonly sameEnd?: undefined;
  readonly key?: undefined;
  readonly edge?: undefined;
  readonly text?: undefined;
}

export interface ReplaySame {
  readonly sameEnd: true;
  readonly checked: boolean;
  readonly ruleHolds: boolean;
  readonly reason?: undefined;
  readonly key?: undefined;
  readonly edge?: undefined;
  readonly text?: undefined;
}

interface ReplayApart {
  readonly modelStep: number;
  readonly said: string | null;
  readonly from: string;
  readonly hidden: boolean;
  readonly key: string;
  readonly reason?: undefined;
  readonly sameEnd?: undefined;
}

// The other model cannot take the bug's step.
export interface ReplayStopped extends ReplayApart {
  readonly label: string | null;
  readonly disabled: true;
  readonly own?: undefined;
}

// The other model takes another step, whose words are own.
export interface ReplayMoved extends ReplayApart {
  readonly label: string;
  readonly own: string;
  readonly disabled?: undefined;
}

export type Replay = ReplayStart | ReplaySame | ReplayStopped | ReplayMoved;

// Where the other model leaves a bug's path, and the arrow that the chart draws for it.
export type Divergence = (ReplayStopped | ReplayMoved) & {
  readonly step: number;
  readonly text: string;
  readonly overview: string;
  readonly edge: string;
  readonly apart?: true;
};

export type SecondOutcome = ReplayStart | ReplaySame | Divergence;

// A bug with its path in reader steps and what the other model does on it.
export interface PathBug extends Bug {
  readonly path: ReaderStop[];
  readonly end: string;
  readonly second: SecondOutcome | null;
  readonly introduced?: boolean;
}

// The steps that lead into a bug, which ways-in.ts counts.
export interface BugWays {
  readonly lastSteps: string[];
  readonly keptSteps: Set<string>;
  readonly nameless: { readonly action: string | null; readonly all: boolean } | null;
  readonly waysIn: number;
  readonly startsHere: boolean;
}

export type ChartBug = PathBug & BugWays;

// A bug whose other model leaves its path.
export type DivergingBug = PathBug & { readonly second: Divergence };

// How the chart draws one state: its group, its status, and its Mermaid class.
export interface DrawnState {
  readonly group: string;
  readonly status: Status;
  readonly cls: string;
}

export interface GroupCount {
  readonly name: string;
  readonly color: string | undefined;
  readonly states: number;
}

// The legend entry of each status that the chart can use: its Mermaid id and its words. worse is
// there only with --fixed, the only run whose states can be worse.
export type Legend = Record<string, [string, string]>;

// A state label "context: progress" cut into its two region states.
export type Split = [string, string];

// A step of the flat chart between two split states.
export interface SplitStep {
  readonly from: Split;
  readonly to: Split;
  readonly label: string;
}

// What tlc-to-chart.ts gives regions-chart.ts to draw the overview as two parallel regions.
export interface RegionsInput {
  readonly states: Set<string>;
  readonly starts: string[];
  readonly edges: Map<string, ChartEdge>;
  readonly loops: boolean;
  readonly classes: ChartBug[];
  readonly proofPath: string | undefined;
  readonly allPath: string | undefined;
  readonly mapping: Mapping;
  readonly status: (k: string) => Status;
  readonly LEGEND: Legend;
  readonly groupOf: (k: string) => string;
  readonly drawnState: (group: string, status: Status, path?: boolean) => DrawnState;
  readonly groupCounts: (drawn: DrawnState[]) => GroupCount[];
  readonly head: (drawn: DrawnState[]) => string[];
}

// What summary.json says about the overview's regions.
export type RegionsSummary =
  | {
      readonly drawn: true;
      readonly states: [number, number];
      readonly transitions: number;
      readonly all: number;
      readonly flat: { readonly states: number; readonly transitions: number };
    }
  | { readonly drawn: false; readonly why: string };

// What summary.json says about --cover.
export type CoverSummary =
  | { readonly drawn: false; readonly why: string }
  | {
      readonly drawn: true;
      readonly states: number;
      readonly transitions: number;
      readonly leftOutStates: string[];
      readonly leftOutTransitions: string[];
    };

// An arrow of the flat overview: its numbered steps, the main model's labels, and the other
// model's labels.
export interface Arrow {
  readonly from: string;
  readonly to: string;
  readonly groups: [(string | undefined)[], (string | undefined)[], (string | undefined)[]];
  plain: boolean;
  readonly labels: string[];
}

// The overview as two parallel regions, or why it has none.
export type RegionsChart =
  | { readonly why: string; readonly mermaid?: undefined }
  | {
      readonly why?: undefined;
      readonly mermaid: string;
      readonly states: [number, number];
      readonly transitions: number;
      readonly all: number;
      readonly flat: { readonly states: number; readonly transitions: number };
      readonly status: Record<string, number>;
      readonly groups: GroupCount[];
    };

// ---------------------------------------------------------------------------------------------
// Rendering a chart to a PNG with Pele and resvg

// The colors of a status, or of the region boxes.
export interface Mark {
  readonly fill: string;
  readonly border: string;
  readonly text: string;
}

// The colors of a PNG. A theme without groups keeps the group fills from the chart's classDef
// lines.
export interface Theme {
  readonly background: string;
  readonly stateFill: string;
  readonly stateBorder: string;
  readonly stateText: string;
  readonly edge: string;
  readonly edgeLabel: string;
  readonly region: Mark;
  readonly groups: string[] | null;
  readonly groupBorder: string | null;
  readonly wrong: Mark;
  readonly fixed: Omit<Mark, "text">;
  readonly mixed: Mark;
  readonly after: Mark;
  readonly worse: Mark;
  readonly path: string;
}

export interface RenderOptions {
  readonly theme?: Theme;
  readonly systemFont?: string | null;
}

// A font file that fc-match found, or only a family name for resvg to look up.
export interface Face {
  readonly file?: string;
  readonly name: string;
}

export interface RenderedSvg {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

export interface Measurer {
  width(text: string, size: number, style?: number): number;
}

export interface ResvgOptions {
  readonly background?: string;
  readonly fitTo?: { readonly mode: "zoom"; readonly value: number };
  readonly font?: {
    readonly loadSystemFonts: boolean;
    readonly fontFiles?: string[];
    readonly defaultFontFamily?: string;
    readonly sansSerifFamily?: string;
  };
}

export interface Resvg {
  getBBox(): { readonly width: number } | undefined;
  render(): { asPng(): Buffer };
}

// The cached entry.mjs: Pele's render and resvg's Resvg. Pele declares measurer as optional, and
// the renderer passes null when no font draws.
export interface RendererLib {
  render(src: string, options?: { fontFamily: string; measurer: Measurer | null | undefined }): RenderedSvg;
  readonly Resvg: new (svg: string, options: ResvgOptions) => Resvg;
}
