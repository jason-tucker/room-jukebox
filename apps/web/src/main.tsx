import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { router } from './router.tsx';
import './index.css';

async function boot(): Promise<void> {
  // Dev-only in-browser hub (src/dev/mock.ts). The condition is a build-time constant, so a normal
  // build drops the import entirely.
  if (import.meta.env.VITE_MOCK === '1') {
    const { installMock } = await import('./dev/mock.ts');
    installMock();
  }

  const container = document.getElementById('root');
  if (!container) throw new Error('#root element missing');

  createRoot(container).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}

void boot();
