import { SandboxInstance } from "@blaxel/core"
import { createOrGetSandbox } from "../utils"

const env = process.env.BL_ENV || "prod"
const sandboxName = "sandbox-test-cors"

interface CorsTestCase {
    name: string
    origin: string
    methods: string
    headers: string
    testOrigin?: string // The origin to use in the test request
}

const testCases: CorsTestCase[] = [
    {
        name: "wildcard-all",
        origin: "*",
        methods: "GET, POST, PUT, DELETE, OPTIONS",
        headers: "Content-Type, Authorization",
        testOrigin: "https://example.com", // Any origin should work with wildcard
    },
    {
        name: "specific-origin",
        origin: "https://my-app.com",
        methods: "GET, POST, PUT, DELETE, OPTIONS",
        headers: "Content-Type, Authorization",
        testOrigin: "https://my-app.com",
    },
    {
        name: "get-only",
        origin: "https://my-app.com",
        methods: "GET, OPTIONS",
        headers: "Content-Type, Authorization",
        testOrigin: "https://my-app.com",
    },
    {
        name: "post-only",
        origin: "https://my-app.com",
        methods: "POST, OPTIONS",
        headers: "Content-Type, Authorization",
        testOrigin: "https://my-app.com",
    },
    {
        name: "custom-headers",
        origin: "https://my-app.com",
        methods: "GET, POST, PUT, DELETE, OPTIONS",
        headers: "Content-Type, Authorization, X-Custom-Header, X-Request-ID",
        testOrigin: "https://my-app.com",
    },
    {
        name: "multiple-origins",
        origin: "https://app1.com, https://app2.com",
        methods: "GET, POST, OPTIONS",
        headers: "Content-Type, Authorization",
        testOrigin: "https://app1.com",
    }
]

async function main() {
    console.log("🚀 Starting CORS Test Suite")
    console.log("=" .repeat(50))

    let sandbox: SandboxInstance
    let allTestsPassed = true
    const results: { name: string; passed: boolean; error?: string }[] = []

    try {
        // Create and setup sandbox
        console.log("\n📦 Creating sandbox...")
        sandbox = await createOrGetSandbox({
            sandboxName,
            image: `blaxel/nextjs:latest`
        })

        // Start the Next.js dev server
        console.log("🔧 Starting Next.js dev server...")
        await sandbox.process.exec({
            command: "npm run dev",
            workingDir: "/blaxel/app",
            waitForPorts: [3000],
        })


        console.log("\n📝 Running CORS tests...")
        console.log("-" .repeat(50))

        // Run tests for each configuration
        for (const testCase of testCases) {
            console.log(`\n🧪 Testing: ${testCase.name}`)

            try {
                // Create preview with specific CORS configuration
                const preview = await sandbox.previews.create({
                    metadata: {
                        name: `cors-test-${testCase.name}`,
                    },
                    spec: {
                        port: 3000,
                        responseHeaders: {
                            "Access-Control-Allow-Origin": testCase.origin,
                            "Access-Control-Allow-Methods": testCase.methods,
                            "Access-Control-Allow-Headers": testCase.headers,
                            "Access-Control-Allow-Credentials": "true",
                        },
                        public: true,
                    }
                })

                if (!preview.spec?.url) {
                    throw new Error("Preview URL not available")
                }

                console.log(`   Preview URL: ${preview.spec.url}`)

                // Test CORS configuration
                await testCors({
                    name: testCase.name,
                    origin: testCase.origin,
                    methods: testCase.methods,
                    headers: testCase.headers,
                    url: preview.spec.url,
                    testOrigin: testCase.testOrigin || testCase.origin,
                })

                // Test preflight request
                await testPreflightRequest({
                    name: testCase.name,
                    origin: testCase.origin,
                    methods: testCase.methods,
                    headers: testCase.headers,
                    url: preview.spec.url,
                    testOrigin: testCase.testOrigin || testCase.origin,
                })

                // Clean up preview
                await sandbox.previews.delete(preview.metadata?.name || "")

                console.log(`   ✅ ${testCase.name}: PASSED`)
                results.push({ name: testCase.name, passed: true })

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error)
                console.error(`   ❌ ${testCase.name}: FAILED - ${errorMessage}`)
                results.push({ name: testCase.name, passed: false, error: errorMessage })
                allTestsPassed = false
            }
        }

        // Print summary
        console.log("\n" + "=" .repeat(50))
        console.log("📊 Test Summary")
        console.log("-" .repeat(50))

        const passedCount = results.filter(r => r.passed).length
        const failedCount = results.filter(r => !r.passed).length

        console.log(`Total Tests: ${results.length}`)
        console.log(`✅ Passed: ${passedCount}`)
        console.log(`❌ Failed: ${failedCount}`)

        if (failedCount > 0) {
            console.log("\nFailed Tests:")
            results.filter(r => !r.passed).forEach(r => {
                console.log(`  - ${r.name}: ${r.error}`)
            })
        }

        console.log("\n" + "=" .repeat(50))

        if (allTestsPassed) {
            console.log("🎉 All CORS tests passed successfully!")
        } else {
            console.log("⚠️  Some tests failed. Please review the errors above.")
            process.exit(1)
        }

    } catch (error) {
        console.error("\n💥 Fatal error during test execution:", error)
        process.exit(1)
    } finally {
        await SandboxInstance.delete(sandboxName)
    }
}

// Helper function to fetch with timeout
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = 100): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        })
        clearTimeout(timeoutId)
        return response
    } catch (error) {
        clearTimeout(timeoutId)
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeoutMs}ms`)
        }
        throw error
    }
}

// Test CORS headers in response
async function testCors(config: {
    name: string
    origin: string
    methods: string
    headers: string
    url: string
    testOrigin: string
}) {
    // Test OPTIONS preflight request
    const response = await fetchWithTimeout(config.url, {
        method: "OPTIONS",
        headers: {
            "Origin": config.testOrigin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type",
        },
    })

    if (response.status !== 200 && response.status !== 204) {
        throw new Error(`Preflight request failed with status ${response.status}`)
    }

    // Check CORS headers
    const allowOrigin = response.headers.get("access-control-allow-origin")
    const allowMethods = response.headers.get("access-control-allow-methods")
    const allowHeaders = response.headers.get("access-control-allow-headers")

    // For wildcard origin, it should return *
    // For specific origins, it should match the configured origin
    if (config.origin === "*") {
        if (allowOrigin !== "*") {
            throw new Error(`Expected Access-Control-Allow-Origin: *, got: ${allowOrigin}`)
        }
    } else {
        // For multiple origins, the server might return the specific origin from the request
        const allowedOrigins = config.origin.split(",").map(o => o.trim())
        if (!allowOrigin || (!allowedOrigins.includes(allowOrigin) && allowOrigin !== config.origin)) {
            throw new Error(`Expected Access-Control-Allow-Origin to be one of ${config.origin}, got: ${allowOrigin}`)
        }
    }

    // Check methods
    if (allowMethods !== config.methods) {
        throw new Error(`Expected Access-Control-Allow-Methods: ${config.methods}, got: ${allowMethods}`)
    }

    // Check headers
    if (allowHeaders !== config.headers) {
        throw new Error(`Expected Access-Control-Allow-Headers: ${config.headers}, got: ${allowHeaders}`)
    }
}

// Test preflight request with different methods
async function testPreflightRequest(config: {
    name: string
    origin: string
    methods: string
    headers: string
    url: string
    testOrigin: string
}) {
    const methodsToTest = config.methods.split(",").map(m => m.trim()).filter(m => m !== "OPTIONS")

    for (const method of methodsToTest) {
        const response = await fetchWithTimeout(config.url, {
            method: "OPTIONS",
            headers: {
                "Origin": config.testOrigin,
                "Access-Control-Request-Method": method,
                "Access-Control-Request-Headers": "Content-Type",
            },
        })

        if (response.status !== 200 && response.status !== 204) {
            throw new Error(`Preflight for ${method} failed with status ${response.status}`)
        }

        const allowedMethods = response.headers.get("access-control-allow-methods")
        if (!allowedMethods || !allowedMethods.includes(method)) {
            throw new Error(`Method ${method} not allowed in CORS response. Allowed: ${allowedMethods}`)
        }
    }
}

// Run the tests
main().catch(error => {
    console.error("Unexpected error:", error)
    process.exit(1)
})
