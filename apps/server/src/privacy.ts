import type { PrivacyReply } from '@room-jukebox/shared';

/**
 * The privacy policy served at `GET /api/privacy.json` (plan §3.3 "Policy hygiene"; YouTube API
 * Services Developer Policies III.A.2.a–g and III.E.4.i). The `/privacy` page renders it.
 */
export const PRIVACY_POLICY: PrivacyReply = {
  updatedAt: '2026-10-09',
  sections: [
    {
      heading: 'Who runs this jukebox',
      body: 'Room Jukebox is a party jukebox that runs on the host’s own laptop. The host (the owner of this laptop) decides what it plays. Nothing here is a cloud service: your requests go to that laptop over the local network.',
    },
    {
      heading: 'YouTube API Services',
      body: 'This app uses YouTube API Services to look up videos, search and play music. By using it you agree to the YouTube Terms of Service (https://www.youtube.com/t/terms). Google’s privacy policy applies to the data YouTube handles: https://policies.google.com/privacy.',
    },
    {
      heading: 'What we collect',
      body: 'When you request a song the jukebox stores: the display name you choose (optional), a random guest ID kept in a cookie so the queue can show which songs are yours, your device’s local network address (to apply the room’s request and search limits fairly), and your request history (which videos you asked for and when). It does not collect your email, phone number, location or contacts.',
    },
    {
      heading: 'How it is used',
      body: 'Your name is shown next to your songs on the TV and in the queue. Your guest ID and network address are used only to apply this room’s limits (songs waiting per guest, time between requests, searches per day). Request history feeds the music that plays when nobody has requested anything.',
    },
    {
      heading: 'Who it is shared with',
      body: 'Data stays on the host’s laptops. In a multi-room setup the host’s other laptop keeps a copy (a replica) so the party survives one laptop going away. If the host asks the developer for help, a diagnostics bundle with logs may be sent to the developer for troubleshooting. Nothing is sold or shared with advertisers by this app.',
    },
    {
      heading: 'YouTube and advertising',
      body: 'Songs play in YouTube’s embedded player on the TV, which may show YouTube advertising. When the player loads, it shares basic data with YouTube (such as the TV laptop’s address and the video being played), as any embedded YouTube video does.',
    },
    {
      heading: 'Cookies and local storage',
      body: 'The jukebox uses a guest cookie (your random guest ID), an owner cookie for the host’s admin page, and your browser’s local storage to remember that you accepted this notice and which jukebox addresses you have used. No tracking or advertising cookies are set by this app.',
    },
    {
      heading: 'Your choices and deleting your data',
      body: 'Use “Forget me” on the jukebox page at any time: it deletes your guest record and removes your name and guest ID from the queue and the request history right away (anonymous play history and per-address counters are kept so limits still work). The host can also delete a guest’s data from the admin page. Backups roll over within 7 days, so deleted data is gone from every copy within 7 days. Forget me does not affect data stored by YouTube or Google; manage that at https://myaccount.google.com/permissions and https://myactivity.google.com.',
    },
    {
      heading: 'Children',
      body: 'Room Jukebox is not directed at children under 13.',
    },
    {
      heading: 'Contact',
      body: 'Questions about this jukebox or your data: ask the host of the party, or contact the developer through the project page listed in the app’s About screen.',
    },
  ],
};
