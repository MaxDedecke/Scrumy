import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ requirementId: string }> },
) {
  const { requirementId } = await params;

  const requirement = await prisma.requirement.findUnique({ where: { id: requirementId } });
  if (!requirement || !requirement.fileData) {
    return new NextResponse("Nicht gefunden", { status: 404 });
  }

  return new NextResponse(new Uint8Array(requirement.fileData), {
    headers: {
      "Content-Type": requirement.fileType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${(requirement.fileName ?? "datei").replace(/"/g, "")}"`,
    },
  });
}
