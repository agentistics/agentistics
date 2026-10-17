/**
 * newProjectProto.ts — PROTOTYPE switch for "Novo projeto" (t-eab4751cb3). Throwaway.
 *
 * The prototype page (`proto/new-project`) sets which option the wizard draws and the home it
 * computes the default location under. In the real feature the server would send the default
 * location in `/api/fleet/new` (see ~/.agentistics/leader/new-project-options.md) and this file goes.
 */
export const newProjectProto: { variant?: 'A' | 'B' | 'C'; home: string } = { home: '' }
