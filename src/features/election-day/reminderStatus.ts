export function isReminderActive(reminderAt: string | null): boolean {
  return reminderAt !== null && new Date(reminderAt).getTime() > Date.now();
}
