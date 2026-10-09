import { createBrowserRouter } from 'react-router';
import { Placeholder } from './routes/Placeholder.tsx';

export const router = createBrowserRouter([
  { path: '/', element: <Placeholder title="Room Jukebox" /> },
  { path: '/tv', element: <Placeholder title="TV" /> },
  { path: '/admin', element: <Placeholder title="Admin" /> },
  { path: '/setup', element: <Placeholder title="Setup" /> },
  { path: '/settings', element: <Placeholder title="Settings" /> },
  { path: '/privacy', element: <Placeholder title="Privacy" /> },
  { path: '*', element: <Placeholder title="Not found" /> },
]);
