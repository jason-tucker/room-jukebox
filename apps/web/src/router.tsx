import { createBrowserRouter } from 'react-router';
import { Placeholder } from './routes/Placeholder.tsx';
import { Admin } from './routes/admin/Admin.tsx';
import { Guest } from './routes/Guest.tsx';
import { Privacy } from './routes/Privacy.tsx';
import { Setup } from './routes/Setup.tsx';
import { Spike } from './routes/Spike.tsx';
import { Tv } from './routes/Tv.tsx';
import { TvSpike } from './routes/TvSpike.tsx';

export const router = createBrowserRouter([
  { path: '/', element: <Guest /> },
  // A split room's own queue (contract-m2 §3); the QR on that room's TV points here.
  { path: '/r/:groupId', element: <Guest /> },
  { path: '/tv', element: <Tv /> },
  { path: '/tv-spike', element: <TvSpike /> },
  { path: '/spike', element: <Spike /> },
  { path: '/admin', element: <Admin /> },
  // M1: the desktop settings window loads the same owner page (with its bearer token).
  { path: '/settings', element: <Admin /> },
  { path: '/setup', element: <Setup /> },
  { path: '/privacy', element: <Privacy /> },
  { path: '*', element: <Placeholder title="Not found" /> },
]);
