/**
 * LIVE.12S — whether the Agentask page shows ONLY the loader while the board's first answer is out.
 *
 * Every view draws from the task list except Live, which reads its own endpoint
 * (`/api/tasks/live`) and draws nothing from it: making Live wait for `/api/tasks` put the board's
 * answer (and the page chunk and filters ahead of it) on the Live critical path.
 */
export function waitsForTaskList(rows: unknown | null, view: string): boolean {
  return rows === null && view !== 'live'
}
