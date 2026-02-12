#!/bin/bash

# Cloud Deployment Script for Event-Driven Integration Service
# This script helps with Railway deployment setup

set -e

echo "🚀 Event-Driven Integration Service - Cloud Deployment"
echo "====================================================="

# Check if Railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo "❌ Railway CLI not found. Install it first:"
    echo "npm install -g @railway/cli"
    exit 1
fi

# Login to Railway
echo "🔐 Logging into Railway..."
railway login

# Initialize project
echo "📁 Initializing Railway project..."
railway init event-driven-integration-service

# Add services
echo "🗄️ Adding PostgreSQL..."
railway add postgresql

echo "🔄 Adding Redis..."
railway add redis

echo "📊 Adding Jaeger (optional)..."
railway add jaeger || echo "Jaeger not available, skipping..."

# Set environment variables
echo "🔧 Setting up environment variables..."
railway variables set NODE_ENV=production
railway variables set PORT=3001
railway variables set OTEL_SERVICE_NAME=event-driven-integration-service

echo "⚠️  IMPORTANT: Set webhook secrets manually in Railway dashboard:"
echo "   - STRIPE_WEBHOOK_SECRET"
echo "   - PAYPAL_WEBHOOK_SECRET"
echo "   - GITHUB_WEBHOOK_SECRET"
echo ""

# Deploy
echo "🚀 Deploying application..."
railway up

echo "✅ Deployment initiated!"
echo ""
echo "📋 Next steps:"
echo "1. Set webhook secrets in Railway dashboard"
echo "2. Run database migrations: railway run npm run prisma:migrate"
echo "3. Check health endpoint: curl https://your-app.railway.app/health"
echo "4. View logs: railway logs"
echo "5. Access Jaeger UI through Railway dashboard"