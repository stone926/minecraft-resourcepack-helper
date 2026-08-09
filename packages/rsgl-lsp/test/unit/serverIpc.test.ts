import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  type MessageConnection
} from "vscode-jsonrpc/node";
import {
  rsglResourceNavigationRequest,
  type RsglResourceNavigationRequest,
  type RsglResourceNavigationResponse
} from "../../../rsgl-shared/src";

describe("RSGL server stdio integration", () => {
  it("loads the document project before requesting a physical definition", async function () {
    this.timeout(10_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsgl-lsp-definition-"));
    const source = [
      "extern local model minecraft:block/cube_all",
      "model block child {",
      "  parent block/cube_all",
      "}"
    ].join("\n");
    const sourceFileName = path.join(root, "main.rsgl");
    fs.writeFileSync(sourceFileName, source, "utf8");

    const serverFileName = path.resolve(__dirname, "../../src/server.js");
    const child = spawn(process.execPath, [serverFileName, "--stdio"], {
      cwd: root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", chunk => stderr.push(chunk));
    let connection: MessageConnection | undefined;

    try {
      connection = createMessageConnection(child.stdout, child.stdin);
      const requests: RsglResourceNavigationRequest[] = [];
      const physicalLocation = {
        uri: pathToFileURL(path.join(root, "cube_all.json")).toString(),
        range: {
          start: { line: 2, character: 4 },
          end: { line: 2, character: 18 }
        }
      };
      connection.onRequest(
        rsglResourceNavigationRequest,
        (request: RsglResourceNavigationRequest): RsglResourceNavigationResponse => {
          requests.push(request);
          return {
            protocolVersion: request.protocolVersion,
            requestGeneration: request.requestGeneration,
            operation: request.operation,
            status: "resolved",
            coverage: "authoritative",
            locations: [{ ...physicalLocation, origin: "physical" }]
          };
        }
      );
      connection.onRequest("workspace/semanticTokens/refresh", () => null);
      connection.listen();

      const rootUri = pathToFileURL(root).toString();
      const documentUri = pathToFileURL(sourceFileName).toString();
      await connection.sendRequest("initialize", {
        processId: process.pid,
        rootUri,
        capabilities: {},
        workspaceFolders: [{ uri: rootUri, name: "fixture" }]
      });
      connection.sendNotification("initialized", {});
      connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: documentUri,
          languageId: "rsgl",
          version: 1,
          text: source
        }
      });

      const literalOffset = source.lastIndexOf("block/cube_all") + 2;
      const literalPrefix = source.slice(0, literalOffset);
      const definition = await connection.sendRequest("textDocument/definition", {
        textDocument: { uri: documentUri },
        position: {
          line: literalPrefix.split("\n").length - 1,
          character: literalPrefix.length - literalPrefix.lastIndexOf("\n") - 1
        }
      });

      assert.strictEqual(requests.length, 1, [
        "the server did not ask the client to resolve the resource literal;",
        "it may have treated the .rsgl file path as a source directory",
        Buffer.concat(stderr).toString("utf8")
      ].filter(Boolean).join(" "));
      assert.deepStrictEqual(requests[0].target, {
        kind: "model",
        id: "minecraft:block/cube_all"
      });
      assert.deepStrictEqual(definition, [physicalLocation]);
    } finally {
      if (connection) {
        try {
          await connection.sendRequest("shutdown");
          connection.sendNotification("exit");
        } catch {
          // The child may already have exited after an assertion or protocol failure.
        }
        connection.dispose();
      }
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
