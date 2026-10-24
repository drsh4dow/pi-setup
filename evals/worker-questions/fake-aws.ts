#!/usr/bin/env node
// An `aws` for the staging account whose SSO session expires after a few calls, so the worker
// meets an external blocker mid-task. Only the parent can log in again: the runner refreshes the
// session when the parent answers or sends a directive. Without $WQ_AWS_STATE it has no
// credentials, so a run never reaches a real account. Every call appends to $WQ_AWS_LOG.

import { appendFileSync } from "node:fs";
import { BUCKETS, readAwsState, writeState } from "./tools-state.ts";

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

class AwsExit extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const json = (value: Json) => `${JSON.stringify(value, null, 4)}\n`;

function profileOf(args: readonly string[]): string | undefined {
  const index = args.indexOf("--profile");

  return index === -1 ? process.env.AWS_PROFILE : args[index + 1];
}

function serve(args: readonly string[]): string {
  const words = args.filter(
    (arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"),
  );

  const [service, operation] = words;
  const flag = (name: string) => args[args.indexOf(name) + 1];

  if (service === "sts" && operation === "get-caller-identity") {
    return json({
      UserId: "AROAEXAMPLE:sam",
      Account: "111122223333",
      Arn: "arn:aws:sts::111122223333:assumed-role/Developer/sam",
    });
  }

  if (service === "s3api" && operation === "list-buckets") {
    return json({
      Buckets: [...BUCKETS.keys()].map((Name) => ({
        Name,
        CreationDate: "2025-01-15T09:00:00+00:00",
      })),
    });
  }

  if (service === "s3" && operation === "ls" && words.length === 2) {
    return [...BUCKETS.keys()].map((name) => `2025-01-15 09:00:00 ${name}\n`).join("");
  }

  if (service === "s3api" && operation === "get-bucket-tagging") {
    const bucket = flag("--bucket");

    if (bucket === undefined || !BUCKETS.has(bucket)) {
      throw new AwsExit(
        254,
        "An error occurred (NoSuchBucket) when calling the GetBucketTagging operation: The specified bucket does not exist",
      );
    }

    const retention = BUCKETS.get(bucket) ?? null;

    if (retention === null) {
      throw new AwsExit(
        254,
        "An error occurred (NoSuchTagSet) when calling the GetBucketTagging operation: The TagSet does not exist",
      );
    }

    return json({
      TagSet: [
        { Key: "retention", Value: retention },
        { Key: "team", Value: "billing" },
      ],
    });
  }

  throw new AwsExit(
    252,
    `fake aws: unsupported command: aws ${args.join(" ")}\nThe staging account serves sts get-caller-identity, s3 ls, s3api list-buckets, and s3api get-bucket-tagging.`,
  );
}

function run(args: readonly string[]): string {
  const statePath = process.env.WQ_AWS_STATE;
  const profile = profileOf(args);

  if (statePath === undefined || profile === undefined) {
    throw new AwsExit(
      253,
      '\nUnable to locate credentials. You can configure credentials by running "aws configure".',
    );
  }

  if (profile !== "staging")
    throw new AwsExit(255, `\nThe config profile (${profile}) could not be found`);

  const state = readAwsState(statePath);

  if (args.includes("sso") && args.includes("login")) {
    writeState(statePath, { ...state, loginAttempts: state.loginAttempts + 1 });
    throw new AwsExit(
      1,
      "Attempting to automatically open the SSO authorization page in your default browser.\nError: no browser is available in this environment. Ask the operator to run `aws sso login --profile staging`.",
    );
  }

  if (state.callsLeft <= 0) {
    writeState(statePath, {
      ...state,
      calls: state.calls + 1,
      expiredCalls: state.expiredCalls + 1,
    });
    throw new AwsExit(
      255,
      "\nAn error occurred (ExpiredToken) when calling the operation: The security token included in the request is expired\nThe SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.",
    );
  }

  writeState(statePath, { ...state, calls: state.calls + 1, callsLeft: state.callsLeft - 1 });

  return serve(args);
}

function log(entry: Readonly<Record<string, Json>>) {
  const path = process.env.WQ_AWS_LOG;

  if (path !== undefined)
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

const args = process.argv.slice(2);

try {
  process.stdout.write(run(args));
  log({ args, exit: 0 });
} catch (error) {
  if (!(error instanceof AwsExit)) throw error;

  process.stderr.write(`${error.message}\n`);
  log({ args, exit: error.code, stderr: error.message });
  process.exitCode = error.code;
}
