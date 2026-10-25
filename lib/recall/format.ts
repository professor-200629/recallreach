/** A time limit in seconds as exact words: "8 minutes", "1 minute 30 s", "45 s". */
export const duration = (s: number) => { const m = Math.floor(s / 60), r = s % 60; return m ? `${m} minute${m === 1 ? '' : 's'}${r ? ` ${r} s` : ''}` : `${r} s`; };
