import {
  type AnchorHTMLAttributes,
  createContext,
  type FormEvent,
  type FormHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { localeOf, pathOf, type Route, routeOf } from './routes.ts';

// No router library (A§15.2, F1): routeOf plus history.pushState. Links are real <a href>s and
// forms are real GET forms, so every page works without JavaScript; with it, a plain left click
// or a submit navigates in place. Another language or another origin always loads the page.

type Router = { path: string; route: Route; navigate(to: string, opts?: { replace?: boolean }): void };

const RouterContext = createContext<Router | null>(null);

export function useRouter(): Router {
  const router = useContext(RouterContext);
  if (router === null) throw new Error('useRouter outside RouterProvider');
  return router;
}

/** The route of a path; a path the server would redirect is shown as not found (links never point there). */
const routeFor = (path: string): Route => {
  const resolved = routeOf(path);
  return resolved.kind === 'route' ? resolved.route : { page: 'not_found', locale: localeOf(path) };
};

export function RouterProvider({ initialPath, children }: { initialPath: string; children: ReactNode }) {
  const [path, setPath] = useState(initialPath);
  const route = useMemo(() => routeFor(path), [path]);
  const navigated = useRef(false);

  useEffect(() => {
    const onPop = () => setPath(location.pathname + location.search);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  // After an in-place navigation: to the top, and focus on <main> for screen readers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on every path change by design
  useEffect(() => {
    if (!navigated.current) return;
    scrollTo(0, 0);
    document.getElementById('main')?.focus();
  }, [path]);

  const navigate = useCallback(
    (to: string, opts?: { replace?: boolean }) => {
      const url = new URL(to, location.href);
      const resolved = routeOf(url.pathname + url.search);
      if (url.origin !== location.origin || resolved.kind !== 'route' || resolved.route.locale !== route.locale) {
        if (opts?.replace === true) location.replace(url.href);
        else location.assign(url.href);
        return;
      }
      const target = resolved.route.page === 'not_found' ? url.pathname + url.search : pathOf(resolved.route);
      navigated.current = true;
      if (opts?.replace === true) history.replaceState(null, '', target);
      else history.pushState(null, '', target);
      setPath(target);
    },
    [route.locale],
  );

  const value = useMemo(() => ({ path, route, navigate }), [path, route, navigate]);
  return <RouterContext value={value}>{children}</RouterContext>;
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

/** An <a href> that navigates in place on a plain left click. */
export function Link({ href, onClick, ...rest }: LinkProps) {
  const { navigate } = useRouter();
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((rest.target !== undefined && rest.target !== '_self') || rest.download !== undefined) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} {...rest} onClick={handle} />;
}

type GetFormProps = Omit<FormHTMLAttributes<HTMLFormElement>, 'method' | 'onSubmit'> & {
  action: string;
  children: ReactNode;
};

/** A GET form that works without JavaScript and navigates in place with it. */
export function GetForm({ action, children, ...rest }: GetFormProps) {
  const { navigate } = useRouter();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const query = new URLSearchParams();
    for (const [name, value] of new FormData(e.currentTarget)) if (typeof value === 'string') query.append(name, value);
    const qs = query.toString();
    navigate(qs === '' ? action : `${action}?${qs}`);
  };
  return (
    <form method="get" action={action} {...rest} onSubmit={submit}>
      {children}
    </form>
  );
}
