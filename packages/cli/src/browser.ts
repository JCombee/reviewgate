import { execFile } from "node:child_process";

/**
 * Opens a URL in the default browser, without a shell.
 *
 * On Windows `start` is a cmd builtin, so we call it through cmd with an empty window
 * title: `start "http://…"` would take the URL as the title. On macOS it is `open`, on
 * Linux `xdg-open`. If it fails that is not an error: the URL is in the terminal too
 * (§4).
 */
export function openBrowser(url: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];

  return new Promise((resolve) => {
    execFile(cmd as string, args as string[], { windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}
