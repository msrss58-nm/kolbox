import { KOLBOX_ORIGIN_URLS } from "../../app/origins";

/**
 * THE ONE definition of what a new Election Owner is told, so the WhatsApp
 * message and the e-mail body cannot drift apart. A pure function: it takes
 * the facts and returns text, touches no state, and sends nothing.
 *
 * The activation link is a CREDENTIAL. It is included deliberately and by
 * approval - the Platform Owner already hands it over by hand today, and
 * these actions only prepare the same message in the operator's own app. Two
 * consequences are worth naming rather than leaving implicit:
 *
 *  - It travels inside a `wa.me` URL, so it can reach browser history on the
 *    operator's machine. That is a real exposure and the reason the message
 *    states, in the message itself, that the link is personal and one-time.
 *  - It is NOT weakened by being sent: the link stays single-use and still
 *    expires. Anyone who redeems it sets a password and burns it, which is
 *    exactly what makes a stolen copy detectable rather than silent.
 *
 * Nothing here is persisted, cached or logged.
 */
export interface OwnerLoginDetails {
  /** The new Owner's display name, as approved. */
  name: string;
  /** Their login username - what they type on the shared login screen. */
  username: string;
  /** The one-time activation link. */
  activationLink: string;
  /** ISO timestamp the approval expires at, when the server returned one. */
  expiresAt: string | null;
}

/** The ONE address every principal signs in at. Taken from the hard-coded
 * origin map, never derived from the activation link or the address bar, so a
 * crafted link cannot repoint where the recipient is sent. */
export const OWNER_LOGIN_URL = KOLBOX_ORIGIN_URLS.sharedLogin;

/**
 * The message body. Hebrew, plain text, and deliberately readable in a
 * WhatsApp bubble as well as an e-mail client - one body for both, because a
 * second wording would be a second thing to keep correct.
 */
export function buildOwnerLoginDetailsMessage(details: OwnerLoginDetails): string {
  const lines = [
    `שלום ${details.name},`,
    "",
    "נוצרה עבורך גישת בעלים במערכת קולבוקס. אלה פרטי הכניסה שלך:",
    "",
    `שם משתמש: ${details.username}`,
    `כתובת כניסה: ${OWNER_LOGIN_URL}`,
    "",
    "קישור להפעלה ולבחירת סיסמה:",
    details.activationLink,
  ];
  if (details.expiresAt) {
    const when = new Date(details.expiresAt);
    // A malformed timestamp must not produce "Invalid Date" in a message sent
    // to a real person - the line is simply dropped instead.
    if (!Number.isNaN(when.getTime())) {
      lines.push("", `הקישור בתוקף עד ${when.toLocaleString("he-IL")}.`);
    }
  }
  lines.push(
    "",
    "הקישור אישי וחד-פעמי - הוא מיועד לך בלבד, ניתן לשימוש פעם אחת, ואין להעביר אותו הלאה.",
  );
  return lines.join("\n");
}

/**
 * A `mailto:` href. Deliberately NOT a provider call: this project has no
 * transactional e-mail, and adding one would be a new integration. The body
 * stays inside the operator's own mail client and never crosses the network
 * as a URL, which is why e-mail is the lower-exposure of the two actions.
 */
export function ownerLoginDetailsMailtoHref(
  email: string,
  subject: string,
  message: string,
): string {
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(message)}`;
}
