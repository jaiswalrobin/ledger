import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
async function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => resolve({ code, output }));
  });
}
async function rehearsal(scenario: string) {
  const directory = await mkdtemp(join(tmpdir(), "ledger-deploy-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    await mkdir(join(directory, "scripts"));
    await writeFile(
      join(directory, "scripts/deploy-production.sh"),
      await readFile(join(root, "scripts/deploy-production.sh")),
    );
    const fixture =
      `#!${process.execPath}\n` +
      String.raw`
import {readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const name=process.argv[1].split('/').at(-1),args=process.argv.slice(2),scenario=process.env.SCENARIO;
const log=command=>appendFileSync('calls.txt',command+'\n');
if(name==='node'){
 if(args.includes('scripts/migrate-production.ts')){log('migrate');process.exit(scenario==='migration-failure'?1:0);}
 const child=spawnSync(process.env.REAL_NODE,args,{env:process.env,stdio:'inherit'});process.exit(child.status??1);
}
if(name==='npm'){
 let live='old';try{live=readFileSync('live.txt','utf8');}catch{}
 log('smoke:'+live);process.exit((['smoke-failure','rollback-failure'].includes(scenario)&&live==='new')?1:0);
}
// Every operation, including recovery, must stay in the configured owner scope.
const scopeIndex=args.indexOf('--scope');
if(scopeIndex<0||args[scopeIndex+1]!==process.env.VERCEL_ORG_ID){console.error('Incorrect Vercel owner scope');process.exit(2);}
const command=args[2];log(command);
let live='old';try{live=readFileSync('live.txt','utf8');}catch{}
let count=0;try{count=Number(readFileSync('inspects.txt','utf8'));}catch{}
const meta=id=>({id:'dpl_'+id,url:id+'.vercel.app'});
if(command==='inspect'){
 count++;writeFileSync('inspects.txt',String(count));
 if(scenario==='lookup-failure'&&count===1)process.exit(1);
 if(scenario==='lookup-invalid'&&count===1){console.log('{}');process.exit(0);}
 if(scenario==='production-changed'&&count===2){console.log(JSON.stringify(meta('other')));process.exit(0);}
 if(scenario==='verification-failure'&&count===3)process.exit(1);
 console.log(JSON.stringify(meta(scenario==='verification-mismatch'&&count===3?'wrong':live)));
}else if(command==='deploy'){
 if(scenario==='build-failure')process.exit(1);console.log(JSON.stringify(meta('new')));
}else if(command==='pull'){
 mkdirSync('.vercel',{recursive:true});writeFileSync('.vercel/.env.production.local','DATABASE_URL_UNPOOLED="synthetic"');
}else if(command==='promote'){
 writeFileSync('live.txt','new');if(scenario==='promotion-response-lost')process.exit(1);
}else if(command==='rollback'){
 if(scenario==='rollback-failure')process.exit(1);writeFileSync('live.txt','old');
}else process.exit(1);
`;
    for (const name of ["npx", "node", "npm"])
      await writeFile(join(bin, name), fixture, { mode: 0o755 });
    // Extension-less mock commands are ES modules, as the real package is.
    await writeFile(join(directory, "package.json"), ' {"type":"module"}');
    const result = await run(
      "bash",
      ["scripts/deploy-production.sh"],
      directory,
      {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REAL_NODE: process.execPath,
        SCENARIO: scenario,
        VERCEL_TOKEN: "synthetic",
        VERCEL_ORG_ID: "synthetic",
        VERCEL_PROJECT_ID: "synthetic",
        PRODUCTION_URL: "https://ledger.example.com",
        GITHUB_SHA: "0123456789012345678901234567890123456789",
        GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
      },
    );
    const calls = (await readFile(join(directory, "calls.txt"), "utf8"))
      .trim()
      .split("\n");
    const summary = await readFile(join(directory, "summary.md"), "utf8");
    await assert.rejects(
      access(join(directory, ".vercel/.env.production.local")),
    );
    return { ...result, calls, summary };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("deployment: stages before migration, validates promotion, then smoke-tests", async () => {
  const r = await rehearsal("success");
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(r.calls, [
    "inspect",
    "deploy",
    "pull",
    "migrate",
    "inspect",
    "promote",
    "inspect",
    "smoke:new",
  ]);
});
for (const scenario of [
  "lookup-failure",
  "lookup-invalid",
  "build-failure",
  "migration-failure",
  "production-changed",
])
  test(`deployment: ${scenario} stops before promotion`, async () => {
    const r = await rehearsal(scenario);
    assert.notEqual(r.code, 0);
    assert.equal(r.calls.includes("promote"), false);
    assert.equal(r.calls.includes("rollback"), false);
    if (scenario.startsWith("lookup") || scenario === "build-failure")
      assert.equal(r.calls.includes("migrate"), false);
  });
for (const scenario of [
  "promotion-response-lost",
  "verification-failure",
  "verification-mismatch",
  "smoke-failure",
])
  test(`deployment: ${scenario} restores and verifies the previous release`, async () => {
    const r = await rehearsal(scenario);
    assert.notEqual(r.code, 0);
    assert.ok(r.calls.includes("rollback"), r.output);
    assert.equal(r.calls.at(-1), "smoke:old", r.output);
    assert.match(r.summary, /Recovery \| verified/);
  });
test("deployment: failed rollback is explicitly reported as unverified recovery", async () => {
  // Trigger smoke failure and keep the new deployment live during the rollback attempt.
  const r = await rehearsal("rollback-failure");
  // The mock must fail smoke for this scenario, not silently accept the bad release.
  assert.notEqual(r.code, 0, r.output);
  assert.match(r.summary, /Recovery \| failed/);
});
test("production dotenv is parsed as literal data, exports only the DB binding, and is removed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ledger-dotenv-"));
  try {
    await mkdir(join(directory, "scripts"));
    const file = join(directory, "production.env");
    const value = "postgresql://synthetic@localhost/db?literal=$(touch owned)";
    await writeFile(
      file,
      `DATABASE_URL_UNPOOLED="${value}"\nGOOGLE_CLIENT_SECRET="synthetic-not-exported"\n`,
    );
    await writeFile(
      join(directory, "scripts/migrate.ts"),
      `if(process.env.DATABASE_URL!==${JSON.stringify(value)}||process.env.GOOGLE_CLIENT_SECRET==='synthetic-not-exported')process.exit(1);`,
    );
    const result = await run(
      process.execPath,
      [
        "--experimental-strip-types",
        join(root, "scripts/migrate-production.ts"),
        file,
      ],
      directory,
      { ...process.env, GITHUB_ACTIONS: "false" },
    );
    assert.equal(result.code, 0, result.output);
    await assert.rejects(access(file));
    await assert.rejects(access(join(directory, "owned")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
