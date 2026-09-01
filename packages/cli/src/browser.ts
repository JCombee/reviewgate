import { execFile } from "node:child_process";

/**
 * Opent een URL in de standaardbrowser, zonder shell.
 *
 * Op Windows is `start` een cmd-ingebouwde; die roepen we expliciet via cmd aan met
 * een lege venstertitel, want `start "http://…"` zou de URL als titel opvatten.
 * Op macOS is het `open`, op Linux `xdg-open`. Lukt het niet, dan is dat geen fout:
 * de URL staat ook in de terminal (§4).
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
