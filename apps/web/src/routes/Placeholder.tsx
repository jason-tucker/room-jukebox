import { PROTOCOL_VERSION } from '@room-jukebox/shared';

export function Placeholder({ title }: { title: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-2 p-4">
      <h1 className="text-3xl font-semibold">{title}</h1>
      <p className="text-sm text-gray-500">Placeholder (protocol v{PROTOCOL_VERSION})</p>
    </main>
  );
}
