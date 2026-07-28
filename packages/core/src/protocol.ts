/**
 * Constants that are part of the wire contract between the public clients and
 * the API, rather than internal to either (#230).
 *
 * They live in `core` because it is the one package every side already depends
 * on: the domain check, the React signup page and the standalone embed script
 * must agree on these exactly, and a name that drifts fails OPEN — the trap
 * silently stops catching anything and nothing reports it.
 */

/**
 * The honeypot field name. Humans never see the field; a bot that fills it is
 * rejected silently, so the failure mode of a mismatch is invisible.
 *
 * `embed.js` is a plain static script with no build step and cannot import this,
 * so it hardcodes the value — a test asserts the two still agree.
 */
export const HONEYPOT_FIELD = "website";

/** The off-screen styling and attributes the trap must carry on every client. */
export const HONEYPOT_ATTRS = {
  tabIndex: -1,
  autoComplete: "off",
  "aria-hidden": true,
  style: {
    position: "absolute" as const,
    left: "-9999px",
    width: "1px",
    height: "1px",
    opacity: 0,
  },
};
