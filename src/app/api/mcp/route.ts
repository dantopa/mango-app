import { NextResponse, type NextRequest } from "next/server";

/**
 * Expone la edge function `maquinita-mcp` bajo nuestro dominio.
 *
 * La function anda bien, pero claude.ai no la puede agregar como custom
 * connector: antes de hablar MCP pide
 * `/.well-known/oauth-protected-resource/<path>` en la raíz del host, y el
 * gateway de Supabase contesta 401 ("No API key found in request") en vez de
 * 404. claude.ai lo lee como "recurso protegido con OAuth", intenta registrarse
 * en un authorization server que no existe, y falla sin llegar a llamar al MCP.
 * Esa ruta no es nuestra y no se puede cambiar. Acá sí da 404, así que el
 * connector entra como no-auth.
 *
 * Pass-through puro: el secret sigue viajando en `?key=` y lo valida la
 * function, que es la que tiene el service-role. Este handler no autoriza nada
 * ni guarda nada, así que no hay una segunda copia del secret que mantener.
 */
const FUNCTION_PATH = "/functions/v1/maquinita-mcp";

export async function POST(req: NextRequest): Promise<Response> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) {
    console.error("[mcp] falta NEXT_PUBLIC_SUPABASE_URL");
    return NextResponse.json({ error: "misconfigured" }, { status: 500 });
  }

  // Por header y no por query: la URL upstream queda sin el secret en los logs.
  const key = req.nextUrl.searchParams.get("key") ?? "";
  const body = await req.text();

  try {
    const upstream = await fetch(`${base}${FUNCTION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-maquinita-key": key },
      body,
      cache: "no-store",
    });

    // 202 = notificación JSON-RPC, sin respuesta: el body vacío es parte del protocolo.
    return new Response(
      upstream.status === 202 ? null : await upstream.text(),
      {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      },
    );
  } catch (err) {
    console.error("[mcp] upstream inalcanzable:", err);
    return NextResponse.json({ error: "upstream_unreachable" }, { status: 502 });
  }
}

/**
 * Streamable HTTP permite no ofrecer stream iniciado por el server, y 405 es la
 * respuesta que el spec pide en ese caso. El cliente sigue con POST.
 */
export function GET(): NextResponse {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
