export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, code?: string) => new HttpError(400, m, code);
export const unauthorized = (m = 'Unauthorized', code = 'UNAUTHORIZED') => new HttpError(401, m, code);
export const forbidden = (m = 'Forbidden', code = 'FORBIDDEN') => new HttpError(403, m, code);
export const notFound = (m = 'Not found') => new HttpError(404, m, 'NOT_FOUND');
export const conflict = (m: string, code = 'CONFLICT') => new HttpError(409, m, code);
