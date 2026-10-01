/**
 * The single owner of this deployment.
 *
 * Maquinita is a one-person app: the bank tokens, the Gmail link, the push
 * devices and every transaction belong to this user. Any other account that
 * manages to log in (a leftover demo user, or a sign-up if the project ever
 * allows them) must not be able to drive the owner's syncs or credentials, so
 * routes that act on owner-scoped data check `isOwner`, not just "logged in".
 */
export const OWNER_USER_ID = process.env.OWNER_USER_ID ?? "e99371b1-6163-4216-b624-c79d8ee01520";

export function isOwner(userId: string | null | undefined): boolean {
  return userId === OWNER_USER_ID;
}
