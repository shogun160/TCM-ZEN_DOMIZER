/**
 * Einmalige Kanal-Verbindung per Twitch-OAuth.
 *
 * Der Scope bleibt bewusst leer: Fuer den Identitaetsnachweis genuegt der
 * Aufruf von /helix/users mit dem User-Token. Der Streamer sieht auf der
 * Twitch-Seite entsprechend "keine besonderen Berechtigungen".
 */

import { createState, consumeState, saveChannelToken } from "./tokens.js";

export async function handleAuthStart(request, env) {
  const origin = new URL(request.url).origin;
  const state = await createState(env);

  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    redirect_uri: `${origin}/auth/callback`,
    response_type: "code",
    scope: "",
    state,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: `https://id.twitch.tv/oauth2/authorize?${params.toString()}` },
  });
}
