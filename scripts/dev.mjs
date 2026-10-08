import { spawn } from "node:child_process";

const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error("Run this launcher through npm: npm run dev");
}

const services = [
  ["frontend", ["--prefix", "frontend", "run", "dev"]],
  ["backend", ["--prefix", "backend", "run", "dev"]],
];

const children = services.map(([name, args]) => {
  const child = spawn(process.execPath, [npmCli, ...args], {
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (code && !process.exitCode) process.exitCode = code;
  });
  return [name, child];
});

const stop = (signal) => {
  for (const [, child] of children) child.kill(signal);
};

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
