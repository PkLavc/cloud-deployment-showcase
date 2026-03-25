import * as crypto from 'crypto';

/**
 * Security utilities for webhook signature verification
 * Implements timing-safe comparison to prevent timing attacks
 */
export class WebhookSecurity {
  /**
   * Verify Stripe webhook signature using HMAC-SHA256
   */
  static verifyStripeSignature(payload: Buffer, signature: string, secret: string): boolean {
    if (!signature || !secret) {
      return false;
    }

    try {
      const expectedSignature = `v1=${crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex')}`;

      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(signature)
      );
    } catch (error) {
      return false;
    }
  }

  /**
   * Verify PayPal webhook signature using HMAC-SHA256
   */
  static verifyPayPalSignature(payload: Buffer, signature: string, secret: string): boolean {
    if (!signature || !secret) {
      return false;
    }

    try {
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('base64');

      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(signature)
      );
    } catch (error) {
      return false;
    }
  }

  /**
   * Verify GitHub webhook signature using HMAC-SHA256
   */
  static verifyGitHubSignature(payload: Buffer, signature: string, secret: string): boolean {
    if (!signature || !secret) {
      return false;
    }

    try {
      const expectedSignature = `sha256=${crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex')}`;

      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(signature)
      );
    } catch (error) {
      return false;
    }
  }

  /**
   * Generate secure cache key with namespace
   */
  static generateCacheKey(namespace: string, identifier: string): string {
    return `${namespace}:${identifier}`;
  }

  /**
   * Validate webhook payload structure
   */
  static validateWebhookPayload(payload: any, requiredFields: string[]): boolean {
    return requiredFields.every(field => payload && payload[field] !== undefined);
  }
}