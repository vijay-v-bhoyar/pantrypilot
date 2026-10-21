import { formatReadiness, providerReadiness } from "./provider-readiness";
const report = providerReadiness(process.env);
console.log(formatReadiness(report));
process.exitCode = report.exitCode;
