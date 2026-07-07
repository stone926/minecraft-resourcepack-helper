import { runRsglCli } from "./cli";

export { parseRsglCliArgs, runRsglCli, type RsglCliArgs, type RsglCliIo } from "./cli";

/** CLI entry point; kept as `main` for the published bin wiring. */
export function main(argv = process.argv.slice(2)): number {
  return runRsglCli(argv);
}

if (require.main === module) {
  process.exitCode = main();
}
