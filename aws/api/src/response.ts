import type { APIGatewayProxyResult } from 'aws-lambda';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

export function ok(body: any): APIGatewayProxyResult {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }, body: JSON.stringify(body) };
}

export function created(body: any): APIGatewayProxyResult {
  return { statusCode: 201, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }, body: JSON.stringify(body) };
}

export function noContent(): APIGatewayProxyResult {
  return { statusCode: 204, headers: CORS_HEADERS, body: '' };
}

export function badRequest(msg: string): APIGatewayProxyResult {
  return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }, body: JSON.stringify({ message: msg }) };
}

export function unauthorized(): APIGatewayProxyResult {
  return { statusCode: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }, body: JSON.stringify({ message: 'Unauthorized' }) };
}

export function forbidden(msg = 'Forbidden'): APIGatewayProxyResult {
  return { statusCode: 403, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }, body: JSON.stringify({ message: msg }) };
}

export function notFound(): APIGatewayProxyResult {
  return { statusCode: 404, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }, body: JSON.stringify({ message: 'Not found' }) };
}

export function serverError(msg: string): APIGatewayProxyResult {
  return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }, body: JSON.stringify({ message: msg }) };
}

/** 402 Payment Required — used to enforce the free-plan meeting limit. The body
    carries machine-readable fields so the client can show an upgrade prompt. */
export function paymentRequired(body: Record<string, unknown>): APIGatewayProxyResult {
  return { statusCode: 402, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }, body: JSON.stringify(body) };
}

export function corsPreflightResponse(): APIGatewayProxyResult {
  return { statusCode: 200, headers: CORS_HEADERS, body: '' };
}
