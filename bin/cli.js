#!/usr/bin/env node
import { readFile } from "node:fs/promises";

async function main() {
  const packageInfo = await readPackageInfo();

  try {
    const args = parseArgs(process.argv.slice(2), packageInfo);

    if (args.help) {
      process.stdout.write(helpText(packageInfo));
      return;
    }

    if (args.version) {
      process.stdout.write(`${packageInfo.version}\n`);
      return;
    }

    console.log("Hello World!");
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(argv, packageInfo) {
  const args = {
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }

    if (arg === "-v" || arg === "--version") {
      args.version = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(
        `Unknown option "${arg}". Run ${packageInfo.name} --help for usage.`,
      );
    }
  }

  return args;
}

async function readPackageInfo() {
  const packageJsonPath = new URL("../package.json", import.meta.url);
  const rawPackageJson = await readFile(packageJsonPath, "utf8");
  return JSON.parse(rawPackageJson);
}

function helpText(packageInfo) {
  const command = packageInfo.name;
  const description = packageInfo.description || "";
  return `${command} ${packageInfo.version}
${description ? `\n${description}\n` : ""}
Usage:
  ${command} [options]

Examples:
  ${command}
  ${command} --help
  ${command} --version

Options:
  -h, --help                       Show this help text.
  -v, --version                    Show the package version.
`;
}

main();
