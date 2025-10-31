import { defineExtension } from "reactive-vscode";
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { exec } from "child_process";

const readFile = promisify(fs.readFile);

/** 
 * In-memory logs from instrumentation.json 
 */
let inMemoryLogs: any[] = [];

/**
 * If user is editing lines, we clear decorations and skip them
 */
let userIsEditing = false;

/**
 * Store each task's status: "idle" | "running" | "success" | "error"
 * We'll show that in the lens
 */
const taskStatusMap = new Map<string, "idle" | "running" | "success" | "error">();

/**
 * A single decoration type for inline text
 */
const decorationType = vscode.window.createTextEditorDecorationType({
  after: {
    color: "#999999",
    margin: "0 0 0 1rem",
  },
});

/** Clears all decorations in the active editor. */
function clearDecorations() {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    editor.setDecorations(decorationType, []);
  }
}

/** Wipes old logs from memory and from the file. */
function wipeOldLogs(logPath: string) {
  inMemoryLogs = [];
  if (fs.existsSync(logPath)) {
    fs.unlinkSync(logPath);
  }
}

/** 
 * Load logs from file, store them, then if userIsEditing = false,
 * display them inline (one call per line).
 */
async function refreshLogsAndDecorations(logPath: string) {
  if (userIsEditing) {
    return;
  }
  try {
    if (!fs.existsSync(logPath)) {
      inMemoryLogs = [];
    } else {
      const data = await readFile(logPath, "utf8");
      const lines = data.split(/\r?\n/).filter((l) => l.trim().length > 0);
      inMemoryLogs = lines.map((line) => JSON.parse(line));
    }
  } catch (err) {
    console.error("Error reading instrumentation file:", err);
    inMemoryLogs = [];
  }

  updateEditorDecorations();
}

/** 
 * Deduplicate logs by line => keep only the last log for each line, 
 * then place them inline if userIsEditing = false.
 */
function updateEditorDecorations() {
  if (userIsEditing) {
    clearDecorations();
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const doc = editor.document;
  const docUri = doc.uri.fsPath;

  const dedupMap = new Map<number, any>();
  for (const log of inMemoryLogs) {
    const { file, line } = log;
    if (!file || !line) continue;
    if (docUri.endsWith(path.basename(file))) {
      dedupMap.set(line, log); // overwrites older logs for that line
    }
  }

  const decorationOptions: vscode.DecorationOptions[] = [];

  for (const [line, log] of dedupMap.entries()) {
    const lineIndex = line - 1;
    if (lineIndex < 0 || lineIndex >= doc.lineCount) continue;
    const lineText = doc.lineAt(lineIndex).text;
    const range = new vscode.Range(lineIndex, lineText.length, lineIndex, lineText.length);
    // If it's a console.log, you might do `log.isConsoleLog === true` check, or treat them the same
    const displayText = ` => ${log.result}`;
    decorationOptions.push({
      range,
      renderOptions: {
        after: {
          contentText: displayText,
        },
      },
    });
  }

  editor.setDecorations(decorationType, decorationOptions);
}

/**
 * CodeLens Provider
 * We find lines like `export const <taskName> = task(`,
 * display "Run <taskName>", or if we have a status:
 *  - "Running <taskName>..."
 *  - "✓ <taskName>"
 *  - "✗ <taskName>" for error
 */
class IceCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  public reload() {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const codeLenses: vscode.CodeLens[] = [];
    const lines = document.getText().split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      const match = lineText.match(/^(?!(?:\s*\/\/)|(?:\s*\/\*))\s*export\s+const\s+(\w+)\s*=\s*task\(/);
      if (match) {
        const taskName = match[1];
        const range = new vscode.Range(i, 0, i, lineText.length);

        let lensTitle = `Run ${taskName}`;
        const status = taskStatusMap.get(taskName) || "idle";
        if (status === "running") {
          lensTitle = `Running ${taskName}...`;
        } else if (status === "success") {
          lensTitle = `✓ ${taskName}`;
        } else if (status === "error") {
          lensTitle = `✗ ${taskName}`;
        }

        codeLenses.push(
          new vscode.CodeLens(range, {
            title: lensTitle,
            command: "extension.runIceTask",
            arguments: [taskName],
          })
        );
      }
    }
    return codeLenses;
  }
}

let codeLensProvider: IceCodeLensProvider | null = null;

export const { activate, deactivate } = defineExtension(
  (context: vscode.ExtensionContext) => {
    // 1) Command: run `npx ice run <taskName>` in background
    const runIceTaskCmd = vscode.commands.registerCommand(
      "extension.runIceTask",
      async (taskName?: string) => {
        if (!taskName) {
          vscode.window.showWarningMessage("No taskName provided");
          return;
        }
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          vscode.window.showWarningMessage("No workspace folder found");
          return;
        }
        const cwd = folders[0].uri.fsPath;

        // Before we run, wipe old logs
        if (logPath) {
          wipeOldLogs(logPath);
        }

        // set the lens to "running"
        taskStatusMap.set(taskName, "running");
        codeLensProvider?.reload();

        // user stops editing => can see logs again
        userIsEditing = false;
        clearDecorations();

        runBackgroundCommand(`npx ice --origin=extension run ${taskName}`, cwd, (err, errorMessage) => {
          if (err) {
            // if error => show codeLens with "✗"
            taskStatusMap.set(taskName, "error");
            // optionally show a popup
            vscode.window.showErrorMessage(`Task ${taskName} failed: ${errorMessage}`);
          } else {
            // success => show "✓" lens
            taskStatusMap.set(taskName, "success");
          }
          codeLensProvider?.reload();

          // If success or error, we parse the new logs
          if (logPath) {
            refreshLogsAndDecorations(logPath);
          }
        });
      }
    );
    context.subscriptions.push(runIceTaskCmd);

    // 2) watch for user editing => userIsEditing = true => remove decorations
    const onChangeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && e.document.uri.fsPath === editor.document.uri.fsPath) {
        userIsEditing = true;
        clearDecorations();
      }
    });
    context.subscriptions.push(onChangeDisposable);

    // (No onDidSave => we do NOT re-show logs on save)

    let logPath: string | undefined;
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const workspaceRoot = folders[0].uri.fsPath;
      logPath = path.join(workspaceRoot, ".ice/logs/instrumentation.json");

      // We'll watch the file, but only show logs if userIsEditing = false
      if (logPath) {
        const logUri = vscode.Uri.file(logPath);
        const watcher = vscode.workspace.createFileSystemWatcher(logUri.fsPath);

        watcher.onDidChange(() => refreshLogsAndDecorations(logPath!));
        watcher.onDidCreate(() => refreshLogsAndDecorations(logPath!));

        context.subscriptions.push(watcher);

        refreshLogsAndDecorations(logPath);
      }
    }

    // 3) Register code lens
    codeLensProvider = new IceCodeLensProvider();
    const selector: vscode.DocumentSelector = {
      scheme: "file",
      language: "typescript",
    };
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(selector, codeLensProvider)
    );
  }
);

/**
 * run cmd in background
 * if error => calls cb(true, errorMessage)
 * else => cb(false)
 */
function runBackgroundCommand(
  cmd: string,
  cwd: string,
  cb: (err: boolean, errorMessage?: string) => void
) {
  exec(cmd, { cwd }, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error running cmd ${cmd}:`, error);
      cb(true, stderr || String(error));
      return;
    }
    if (stdout) console.log("stdout:", stdout);
    if (stderr) console.log("stderr:", stderr);
    cb(false);
  });
}