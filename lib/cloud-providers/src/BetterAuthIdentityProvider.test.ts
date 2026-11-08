import { describe, expect, it } from 'vitest';
import { redirectTarget } from './BetterAuthIdentityProvider';

describe('the address a sign-in may send the page to', () => {
  it('takes an https address, and http on this machine', () => {
    expect(redirectTarget('https://accounts.example.com/o/oauth2?x=1')).toBe(
      'https://accounts.example.com/o/oauth2?x=1',
    );
    expect(redirectTarget('http://localhost:3000/callback')).toBe('http://localhost:3000/callback');
    expect(redirectTarget('http://127.0.0.1:3000/callback')).toBe('http://127.0.0.1:3000/callback');
  });

  it('refuses script, data, plain http elsewhere, relative and missing addresses', () => {
    for (const url of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://evil.example.com/',
      '//evil.example.com/',
      '/relative',
      'not a url',
      '',
      undefined,
    ]) {
      expect(redirectTarget(url), String(url)).toBeNull();
    }
  });
});
