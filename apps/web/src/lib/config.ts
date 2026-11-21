import { createContext, useContext } from 'react';

/** What the browser knows of the config: the brand (from `<meta name="application-name">`). */
export type ClientConfig = { brand: string };

export const ConfigContext = createContext<ClientConfig>({ brand: '' });

export const useConfig = (): ClientConfig => useContext(ConfigContext);
