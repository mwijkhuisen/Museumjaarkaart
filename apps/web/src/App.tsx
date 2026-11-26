import { type QueryClient, QueryClientProvider, useQueries } from '@tanstack/react-query';
import { Component, type ReactNode, useEffect } from 'react';
import { Layout } from './components/layout/Layout.tsx';
import { ApiFailure } from './lib/api.ts';
import { type ClientConfig, ConfigContext, useConfig } from './lib/config.ts';
import { RouterProvider, useRouter } from './lib/router.tsx';
import { apiPathsOf, type Route } from './lib/routes.ts';
import { type ErrorKind, titleOf } from './lib/seo/head.tsx';
import { Account } from './routes/Account.tsx';
import { ErrorPage } from './routes/ErrorPage.tsx';
import { Home } from './routes/Home.tsx';
import { Legal } from './routes/Legal.tsx';
import { MapPage } from './routes/MapPage.tsx';
import { Museum } from './routes/Museum.tsx';
import { Museums } from './routes/Museums.tsx';
import { Province } from './routes/Province.tsx';
import { Search } from './routes/Search.tsx';
import { Shell } from './routes/Shell.tsx';
import { SignIn } from './routes/SignIn.tsx';

// The app, the same tree on the server (entry-server.tsx) and in the browser (entry-client.tsx).

export type AppProps = {
  path: string;
  queryClient: QueryClient;
  config: ClientConfig;
  /** The server's error documents render the layout with this page instead of the route's. */
  fallback?: ErrorKind;
};

export function App({ path, queryClient, config, fallback }: AppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <ConfigContext value={config}>
        <RouterProvider initialPath={path}>
          <Routed fallback={fallback ?? null} />
        </RouterProvider>
      </ConfigContext>
    </QueryClientProvider>
  );
}

function Routed({ fallback }: { fallback: ErrorKind | null }) {
  const { path, route } = useRouter();
  return (
    <Layout route={route}>
      {fallback === null ? (
        <Boundary key={path}>
          <PageFor route={route} />
          <DocumentTitle route={route} />
        </Boundary>
      ) : (
        <ErrorPage kind={fallback} />
      )}
    </Layout>
  );
}

function PageFor({ route }: { route: Route }) {
  switch (route.page) {
    case 'home':
      return <Home route={route} />;
    case 'museums':
      return <Museums route={route} />;
    case 'museum':
      return <Museum route={route} />;
    case 'province':
      return <Province route={route} />;
    case 'search':
      return <Search route={route} />;
    case 'map':
      return <MapPage route={route} />;
    case 'legal':
      return <Legal route={route} />;
    case 'shell':
      if (route.app === 'signin') return <SignIn route={route} />;
      if (route.app === 'account') return <Account route={route} />;
      return <Shell route={route} />;
    case 'not_found':
      return <ErrorPage kind="not_found" />;
  }
}

/** A failed fetch after an in-place navigation: 404 and 400 show the not-found page, the rest the error page. */
class Boundary extends Component<{ children: ReactNode }, { error: ErrorKind | null }> {
  override state: { error: ErrorKind | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: ErrorKind } {
    if (error instanceof ApiFailure && error.status === 404) return { error: 'not_found' };
    if (error instanceof ApiFailure && error.status === 400) return { error: 'bad_request' };
    return { error: 'error' };
  }

  override render() {
    return this.state.error === null ? this.props.children : <ErrorPage kind={this.state.error} />;
  }
}

/** Keeps document.title in step after an in-place navigation, once the page's data is in. Renders nothing. */
function DocumentTitle({ route }: { route: Route }) {
  const { brand } = useConfig();
  const paths = apiPathsOf(route);
  const results = useQueries({ queries: paths.map((p) => ({ queryKey: [p], enabled: false, throwOnError: false })) });
  const ready = results.every((r) => r.data !== undefined);
  const title = ready ? titleOf(route, new Map(paths.map((p, i) => [p, results[i]?.data])), brand) : null;
  useEffect(() => {
    if (title !== null) document.title = title;
  }, [title]);
  return null;
}
