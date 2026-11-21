import { createContext, useContext } from 'react';

/** What the browser knows of the config, read from the head's `<meta>` tags (see `Head`). */
export type ClientConfig = { brand: string; controller: string; contactEmail: string };

export const ConfigContext = createContext<ClientConfig>({ brand: '', controller: '', contactEmail: '' });

export const useConfig = (): ClientConfig => useContext(ConfigContext);
