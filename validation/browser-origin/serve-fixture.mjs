import { writeFile } from "node:fs/promises";
import { encodedEntryPath, listenFixture } from "./fixture.mjs";

const readyFile = process.argv[2];
if (!readyFile) throw new Error("usage: node serve-fixture.mjs <ready-file>");

const server = await listenFixture({
  urlHost: "agent-browser.localhost",
  label: "agent-browser",
});
await writeFile(
  readyFile,
  JSON.stringify({ url: `${server.origin}${encodedEntryPath()}` }),
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
