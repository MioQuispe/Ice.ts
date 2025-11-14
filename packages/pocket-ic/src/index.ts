import path from "node:path"
import { fileURLToPath } from "node:url"
import os from "node:os"
import fs from "node:fs"
import { spawnSync } from "node:child_process"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** The version of the bundled PocketIC server. */
export const pocketIcVersion = "10.0.0"

function getCacheDir(): string {
	const home = os.homedir()
	const platform = os.platform()
	if (platform === "darwin") {
		return path.join(home, "Library", "Caches", "pocket-ic")
	}
	if (platform === "win32") {
		return path.join(
			process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
			"pocket-ic",
			"cache",
		)
	}
	return path.join(home, ".cache", "pocket-ic")
}

function getPlatformInfo(): { name: string; downloadName: string } {
	const platform = os.platform()
	const arch = os.arch()
	if (platform === "darwin" && arch === "arm64") {
		return {
			name: "darwin-arm64",
			downloadName: "pocket-ic-arm64-darwin.gz",
		}
	}
	if (platform === "darwin" && arch === "x64") {
		return {
			name: "darwin-x64",
			downloadName: "pocket-ic-x86_64-darwin.gz",
		}
	}
	if (platform === "linux" && arch === "arm64") {
		return { name: "linux-arm64", downloadName: "pocket-ic-arm64-linux.gz" }
	}
	if (platform === "linux" && arch === "x64") {
		return { name: "linux-x64", downloadName: "pocket-ic-x86_64-linux.gz" }
	}
	throw new Error(
		`Unsupported platform: ${platform}-${arch}. ` +
			`PocketIC binaries are only available for: darwin-arm64, darwin-x64, linux-arm64, linux-x64`,
	)
}

function ensureBinaryExists(): string {
	const cacheDir = getCacheDir()
	const platformInfo = getPlatformInfo()
	const binaryPath = path.join(cacheDir, pocketIcVersion, "pocket-ic")
	if (fs.existsSync(binaryPath)) {
		return binaryPath
	}
	const downloadUrl = `https://github.com/dfinity/pocketic/releases/download/${pocketIcVersion}/${platformInfo.downloadName}`
	try {
		const downloadScript = `
			const https = require("https");
			const fs = require("fs");
			const path = require("path");
			const zlib = require("zlib");
			
			const url = "${downloadUrl}";
			const dest = "${binaryPath}";
			const tmp = dest + ".tmp";
			
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			
			console.log("Downloading PocketIC ${pocketIcVersion}...");
			console.log("From: " + url);
			
			function download(res) {
				if (res.statusCode === 302 || res.statusCode === 301) {
					https.get(res.headers.location, download);
					return;
				}
				
				if (res.statusCode !== 200) {
					console.error("Download failed with status " + res.statusCode);
					process.exit(1);
				}
				
				const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
				let downloadedBytes = 0;
				
				res.on("data", (chunk) => {
					downloadedBytes += chunk.length;
					if (totalBytes > 0) {
						const percent = ((downloadedBytes / totalBytes) * 100).toFixed(1);
						process.stdout.write("\\rDownloading: " + percent + "%");
					}
				});
				
				const gunzip = zlib.createGunzip();
				const write = fs.createWriteStream(tmp, { mode: 0o755 });
				
				res.pipe(gunzip).pipe(write);
				
                write.on("finish", () => {
                    process.stdout.write("\\n");
                    fs.renameSync(tmp, dest);
                    console.log("✓ PocketIC binary downloaded successfully");
                    process.exit(0);
                });
				
				write.on("error", (err) => {
					try { fs.unlinkSync(tmp); } catch {}
					console.error("Write error:", err.message);
					process.exit(1);
				});
			}
			
			https.get(url, download).on("error", (err) => {
				try { fs.unlinkSync(tmp); } catch {}
				console.error("Download error:", err.message);
				process.exit(1);
			});
		`
		const result = spawnSync(process.execPath, ["-e", downloadScript], {
			stdio: "inherit",
			encoding: "utf-8",
		})
		if (result.error || result.status !== 0) {
			throw new Error(
				`Failed to download binary: ${result.error || result.stderr}`,
			)
		}
		if (!fs.existsSync(binaryPath)) {
			throw new Error("Download completed but binary not found")
		}
		return binaryPath
	} catch (error) {
		throw new Error(
			`Failed to download PocketIC binary.\n` +
				`Please download manually from:\n` +
				`  ${downloadUrl}\n` +
				`And extract it to:\n` +
				`  ${binaryPath}\n\n` +
				`Error: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

/** Absolute path to the PocketIC binary (downloads on first use if needed) */
export const pocketIcPath = ensureBinaryExists()

export default pocketIcPath
