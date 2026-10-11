import { actionOptions, getAction, postAction } from "../../../../../../DIALECT.BLINK/provider";
import type { ClusterName } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

function clusterOf(request: Request): ClusterName {
  return new URL(request.url).searchParams.get("c") === "devnet" ? "devnet" : "mainnet-beta";
}

export async function OPTIONS(request: Request) {
  return actionOptions(clusterOf(request));
}

export async function GET(request: Request, context: { params: Promise<{ title: string }> }) {
  const { title } = await context.params;
  return getAction(request, title);
}

export async function POST(request: Request, context: { params: Promise<{ title: string }> }) {
  const { title } = await context.params;
  return postAction(request, title);
}

