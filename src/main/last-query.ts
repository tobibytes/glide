/**
 * The most recent launcher query. Raycast records the typed term together
 * with every launch (frecency.visit({key, searchTerm})) so re-typing the same
 * term later boosts the item; the executor needs the term, but the IPC
 * execute payload only carries the item, so the query handler parks it here.
 */
let lastQuery = "";
export const setLastQuery = (q: string): void => {
  lastQuery = q;
};
export const getLastQuery = (): string => lastQuery;
