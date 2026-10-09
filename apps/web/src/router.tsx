import { createBrowserRouter } from 'react-router';
import { Placeholder } from './routes/Placeholder.tsx';
import { Spike } from './routes/Spike.tsx';
import { Tv } from './routes/Tv.tsx';

export const router = createBrowserRouter([
  { path: '/', element: <Placeholder title="Room Jukebox" /> },
  { path: '/tv', element: <Tv /> },
  { path: '/spike', element: <Spike /> },
  { path: '/admin', element: <Placeholder title="Admin" /> },
  { path: '/setup', element: <Placeholder title="Setup" /> },
  { path: '/settings', element: <Placeholder title="Settings" /> },
  { path: '/privacy', element: <Placeholder title="Privacy" /> },
  { path: '*', element: <Placeholder title="Not found" /> },
]);
