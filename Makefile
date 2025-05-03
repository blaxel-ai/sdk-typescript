ARGS:= $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))

sdk-sandbox:
	cp ../sandbox/sandbox-api/docs/openapi.yml ./definition.yml
	rm -rf @blaxel/sdk/src/sandbox/client/types.gen.ts @blaxel/sdk/src/sandbox/client/sdk.gen.ts
	npx @hey-api/openapi-ts@0.61.0 -i ./definition.yml -o ./tmp/ -c @hey-api/client-fetch
	cp -r ./tmp/* @blaxel/sdk/src/sandbox/client

	sed -i.bak 's/from '\''\.\/sdk\.gen'\''/from '\''\.\/sdk\.gen\.js'\''/g' @blaxel/sdk/src/sandbox/client/index.ts
	sed -i.bak 's/from '\''\.\/types\.gen'\''/from '\''\.\/types\.gen\.js'\''/g' @blaxel/sdk/src/sandbox/client/index.ts
	sed -i.bak '1s/^/\/\* eslint-disable \*\/\n/' @blaxel/sdk/src/sandbox/client/types.gen.ts
	rm -f @blaxel/sdk/src/sandbox/client/index.ts.bak
	rm -f @blaxel/sdk/src/sandbox/client/types.gen.ts.bak
	rm -f @blaxel/sdk/src/sandbox/client/sdk.gen.ts.bak
	rm -rf ./tmp
	rm definition.yml

sdk-controlplane:
	cp ../controlplane/api/api/definitions/controlplane.yml ./definition.yml
	rm -rf @blaxel/sdk/src/client/types.gen.ts @blaxel/sdk/src/client/sdk.gen.ts
	npx @hey-api/openapi-ts@0.61.0 -i ./definition.yml -o ./tmp/ -c @hey-api/client-fetch
	cp -r ./tmp/* @blaxel/sdk/src/client

	sed -i.bak 's/from '\''\.\/sdk\.gen'\''/from '\''\.\/sdk\.gen\.js'\''/g' @blaxel/sdk/src/client/index.ts
	sed -i.bak 's/from '\''\.\/types\.gen'\''/from '\''\.\/types\.gen\.js'\''/g' @blaxel/sdk/src/client/index.ts
	sed -i.bak 's/from '\''\.\/types\.gen'\''/from '\''\.\/types\.gen\.js'\''/g' @blaxel/sdk/src/client/sdk.gen.ts
	sed -i.bak '1s/^/\/\* eslint-disable \*\/\n/' @blaxel/sdk/src/client/types.gen.ts
	rm -f @blaxel/sdk/src/client/index.ts.bak
	rm -f @blaxel/sdk/src/client/sdk.gen.ts.bak
	rm -f @blaxel/sdk/src/client/types.gen.ts.bak
	rm -rf ./tmp
	rm definition.yml

sdk: sdk-sandbox sdk-controlplane

tag:
	git tag -a v$(ARGS) -m "Release v$(ARGS)"
	git push origin v$(ARGS)

%:
	@:

.PHONY: sdk