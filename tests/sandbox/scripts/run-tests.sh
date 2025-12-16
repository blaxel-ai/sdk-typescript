#!/bin/bash

# Sandbox Test Runner
# Usage: ./scripts/run-tests.sh [options]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$SANDBOX_DIR")")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
TEST_TYPE="all"
VERBOSE=false
FILTER=""

usage() {
    echo "Sandbox Test Runner"
    echo ""
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  -t, --type TYPE      Test type: all, integration, benchmark, legacy"
    echo "  -f, --filter PATTERN Filter tests by pattern (passed to vitest)"
    echo "  -v, --verbose        Verbose output"
    echo "  -h, --help           Show this help"
    echo ""
    echo "Examples:"
    echo "  $0                           # Run all integration tests"
    echo "  $0 -t integration            # Run integration tests"
    echo "  $0 -f 'sandbox-crud'         # Run only sandbox-crud tests"
    echo "  $0 -f 'filesystem'           # Run only filesystem tests"
    echo "  $0 -t benchmark              # Run benchmark scripts"
    echo "  $0 -t legacy -f create.ts    # Run specific legacy test"
    echo ""
    echo "Test Categories:"
    echo "  integration:  Vitest-based integration tests (recommended)"
    echo "  benchmark:    Performance benchmark scripts"
    echo "  legacy:       Old standalone test scripts"
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -t|--type)
            TEST_TYPE="$2"
            shift 2
            ;;
        -f|--filter)
            FILTER="$2"
            shift 2
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            usage
            ;;
    esac
done

log() {
    echo -e "${BLUE}[TEST]${NC} $1"
}

success() {
    echo -e "${GREEN}[PASS]${NC} $1"
}

error() {
    echo -e "${RED}[FAIL]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

run_integration_tests() {
    log "Running integration tests..."

    cd "$SANDBOX_DIR"

    VITEST_ARGS=""
    if [ -n "$FILTER" ]; then
        VITEST_ARGS="--testNamePattern=\"$FILTER\""
    fi

    if [ "$VERBOSE" = true ]; then
        VITEST_ARGS="$VITEST_ARGS --reporter=verbose"
    fi

    npx vitest run $VITEST_ARGS
}

run_benchmark_tests() {
    log "Running benchmark tests..."

    cd "$SANDBOX_DIR/benchmarks"

    if [ -n "$FILTER" ]; then
        # Run specific benchmark
        if [ -f "$FILTER" ]; then
            log "Running benchmark: $FILTER"
            npx tsx "$FILTER"
        else
            error "Benchmark not found: $FILTER"
            exit 1
        fi
    else
        # List available benchmarks
        echo ""
        echo "Available benchmarks:"
        for f in *.ts; do
            echo "  - $f"
        done
        echo ""
        echo "Run a specific benchmark with: $0 -t benchmark -f <filename>"
    fi
}

run_legacy_tests() {
    log "Running legacy tests..."

    cd "$SANDBOX_DIR"

    if [ -n "$FILTER" ]; then
        # Run specific legacy test
        if [ -f "$FILTER" ]; then
            log "Running: $FILTER"
            npx tsx "$FILTER"
        else
            error "Test file not found: $FILTER"
            exit 1
        fi
    else
        # List available legacy tests
        echo ""
        echo "Available legacy tests:"
        for f in *.ts *.mts; do
            if [ -f "$f" ]; then
                echo "  - $f"
            fi
        done
        echo ""
        echo "Run a specific test with: $0 -t legacy -f <filename>"
    fi
}

# Main
echo ""
echo "======================================"
echo "  Sandbox Test Runner"
echo "======================================"
echo ""
echo "Environment:"
echo "  BL_ENV: ${BL_ENV:-prod}"
echo "  Test Type: $TEST_TYPE"
if [ -n "$FILTER" ]; then
    echo "  Filter: $FILTER"
fi
echo ""

case $TEST_TYPE in
    all|integration)
        run_integration_tests
        ;;
    benchmark)
        run_benchmark_tests
        ;;
    legacy)
        run_legacy_tests
        ;;
    *)
        error "Unknown test type: $TEST_TYPE"
        usage
        ;;
esac

echo ""
success "Test run completed!"
