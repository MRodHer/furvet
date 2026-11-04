// The ONE place that turns an instant into clinic-local text. Every surface the owner or the doctor
// reads (chat, console, owner messages) shows America/Mexico_City; stored values stay UTC ISO.
export const CLINIC_TZ = "America/Mexico_City";
export const CLINIC_TIME_FORMAT: Intl.DateTimeFormatOptions = { timeZone: CLINIC_TZ, dateStyle: "medium", timeStyle: "short" };

export function formatClinicTime(iso: string): string {
  return new Intl.DateTimeFormat("es-MX", CLINIC_TIME_FORMAT).format(new Date(iso));
}
