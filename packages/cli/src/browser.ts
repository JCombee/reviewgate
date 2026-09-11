import { spawn } from "node:child_process";

/**
 * Opens a URL in the default browser, without a shell.
 *
 * On Windows `start` is a cmd builtin, so we call it through cmd with an empty window
 * title: `start "http://…"` would take the URL as the title. On macOS it is `open`, on
 * Linux `xdg-open`. If it fails that is not an error: the URL is in the terminal too
 * (§4).
 *
 * Detached, with stdio ignored, and unref'd — all three matter. The launcher hands the
 * URL to a browser that outlives it, and a browser that inherited our pipes keeps them
 * open for as long as it runs. Waiting for the launcher's *output* to end therefore
 * means waiting for the browser to be closed, which in the hook is the difference
 * between a gate that reacts and a gate that hangs (§2). So we resolve as soon as the
 * process is spawned and never look back.
 */
export function openBrowser(url: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];

  return new Promise((resolve) => {
    try {
      const child = spawn(cmd as string, args as string[], {
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
