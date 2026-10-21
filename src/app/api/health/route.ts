import { configuration } from "@/lib/config";
import { respond } from "@/lib/http";
export async function GET() {
  return respond(async () => ({
    app: "PantryPilot",
    version: "0.1.0",
    ...configuration(),
    evidence: "Configuration only; not provider connectivity or release proof",
  }));
}
