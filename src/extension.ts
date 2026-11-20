import * as crypto from "crypto";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";

const REPO_NAME = "Benjamin-Davies/nestor";
const BIN_NAME = "nestor";

const execFileAsync = promisify(execFile);

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Nestor");
  context.subscriptions.push(output);

  let command: string;
  try {
    command = await resolveServerPath(context, output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`Failed to locate the language server: ${message}`);
    vscode.window.showErrorMessage(`Nestor: ${message}`);
    return;
  }
  output.appendLine(`Using language server at ${command}`);

  const serverOptions: ServerOptions = { command, args: [] };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "c" }],
    outputChannel: output,
  };

  client = new LanguageClient("nestor", "Nestor", serverOptions, clientOptions);
  await client.start();
}

export async function deactivate() {
  await client?.stop();
}

async function resolveServerPath(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<string> {
  // A user-configured path always wins (e.g. a local dev build).
  const configured = vscode.workspace
    .getConfiguration("nestor")
    .get<string>("server.path");
  if (configured) {
    return configured;
  }

  const storageDir = context.globalStorageUri.fsPath;
  await fs.mkdir(storageDir, { recursive: true });

  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: "Nestor: checking for updates",
      },
      () => installLatest(storageDir, output),
    );
  } catch (err) {
    // Offline or rate limited: fall back to any previously installed version.
    const installed = await findInstalled(storageDir);
    if (installed) {
      output.appendLine(`Update check failed (${err}); using ${installed}`);
      return installed;
    }
    throw err;
  }
}

interface Release {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

async function installLatest(
  storageDir: string,
  output: vscode.OutputChannel,
): Promise<string> {
  const assetName = getAssetName();

  const response = await fetch(
    `https://api.github.com/repos/${REPO_NAME}/releases/latest`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for the latest release`);
  }
  const release = (await response.json()) as Release;

  const versionDir = path.join(storageDir, release.tag_name);
  const binaryPath = path.join(versionDir, BIN_NAME);
  if (await isFile(binaryPath)) {
    return binaryPath;
  }

  const asset = release.assets.find((a) => a.name === assetName);
  const checksumAsset = release.assets.find(
    (a) => a.name === `${assetName}.sha256`,
  );
  if (!asset) {
    throw new Error(`no asset found matching "${assetName}"`);
  }
  if (!checksumAsset) {
    throw new Error(`no checksum found for "${assetName}"`);
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Nestor: downloading ${release.tag_name}`,
    },
    async () => {
      output.appendLine(`Downloading ${asset.browser_download_url}`);
      const archive = await download(asset.browser_download_url);
      const checksumText = await (
        await fetchOk(checksumAsset.browser_download_url)
      ).text();

      // Checksum files look like "<hash>  <filename>".
      const expected = checksumText.trim().split(/\s+/)[0];
      const actual = crypto.createHash("sha256").update(archive).digest("hex");
      if (expected !== actual) {
        throw new Error(`checksum mismatch for ${assetName}`);
      }

      // Extract into a temp dir first so a failed install never leaves a
      // half-populated version directory behind.
      const tmpDir = `${versionDir}.tmp`;
      const archivePath = `${tmpDir}.tar.gz`;
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(archivePath, archive);
      try {
        await execFileAsync("tar", ["-xzf", archivePath, "-C", tmpDir]);
        await fs.chmod(path.join(tmpDir, BIN_NAME), 0o755);
        await fs.rename(tmpDir, versionDir);
      } finally {
        await fs.rm(archivePath, { force: true });
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  // Remove older versions.
  for (const entry of await fs.readdir(storageDir)) {
    if (entry !== release.tag_name) {
      await fs
        .rm(path.join(storageDir, entry), { recursive: true, force: true })
        .catch(() => undefined);
    }
  }

  return binaryPath;
}

async function findInstalled(storageDir: string): Promise<string | undefined> {
  const entries = await fs.readdir(storageDir).catch(() => [] as string[]);
  entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const entry of entries) {
    const candidate = path.join(storageDir, entry, BIN_NAME);
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function getAssetName(): string {
  let target: string;
  if (process.platform === "linux" && process.arch === "x64") {
    target = "x86_64-unknown-linux-musl";
  } else if (process.platform === "darwin" && process.arch === "arm64") {
    target = "aarch64-apple-darwin";
  } else {
    throw new Error(
      `nestor does not publish binaries for ${process.platform}/${process.arch} yet`,
    );
  }
  return `${BIN_NAME}-${target}.tar.gz`;
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for ${url}`);
  }
  return response;
}

async function download(url: string): Promise<Buffer> {
  return Buffer.from(await (await fetchOk(url)).arrayBuffer());
}

async function isFile(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then((s) => s.isFile())
    .catch(() => false);
}