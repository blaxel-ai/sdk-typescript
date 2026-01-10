ARGS:= $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))

install:
	cd @blaxel/core && pnpm install

sdk-sandbox:
	@echo "Downloading sandbox definition from blaxel-ai/sandbox"
	@curl -H "Authorization: token $$(gh auth token)" \
		-H "Accept: application/vnd.github.v3.raw" \
		-o ./definition.yml \
		https://api.github.com/repos/blaxel-ai/sandbox/contents/sandbox-api/docs/openapi.yml?ref=main
	rm -rf @blaxel/core/src/sandbox/client/types.gen.ts @blaxel/core/src/sandbox/client/sdk.gen.ts
	npx @hey-api/openapi-ts@0.66.0 -i ./definition.yml -o ./tmp/ -c @hey-api/client-fetch
	cp -r ./tmp/* @blaxel/core/src/sandbox/client

	sed -i.bak 's/from '\''\.\/sdk\.gen'\''/from '\''\.\/sdk\.gen\.js'\''/g' @blaxel/core/src/sandbox/client/index.ts
	sed -i.bak 's/from '\''\.\/types\.gen'\''/from '\''\.\/types\.gen\.js'\''/g' @blaxel/core/src/sandbox/client/index.ts
	rm -f @blaxel/core/src/sandbox/client/index.ts.bak
	rm -f @blaxel/core/src/sandbox/client/types.gen.ts.bak
	rm -f @blaxel/core/src/sandbox/client/sdk.gen.ts.bak
	rm -rf ./tmp
	rm definition.yml

sdk-controlplane:
	@echo "Downloading controlplane definition from blaxel-ai/controlplane"
	@curl -H "Authorization: token $$(gh auth token)" \
		-H "Accept: application/vnd.github.v3.raw" \
		-o ./definition.yml \
		https://api.github.com/repos/blaxel-ai/controlplane/contents/api/api/definitions/controlplane.yml?ref=main
	rm -rf @blaxel/core/src/client/types.gen.ts @blaxel/core/src/client/sdk.gen.ts
	npx @hey-api/openapi-ts@0.66.0 -i ./definition.yml -o ./tmp/ -c @hey-api/client-fetch
	cp -r ./tmp/* @blaxel/core/src/client

	sed -i.bak 's/from '\''\.\/sdk\.gen'\''/from '\''\.\/sdk\.gen\.js'\''/g' @blaxel/core/src/client/index.ts
	sed -i.bak 's/from '\''\.\/types\.gen'\''/from '\''\.\/types\.gen\.js'\''/g' @blaxel/core/src/client/index.ts
	sed -i.bak 's/from '\''\.\/types\.gen'\''/from '\''\.\/types\.gen\.js'\''/g' @blaxel/core/src/client/sdk.gen.ts
	perl -i -0777 -pe 's/(\{\s*scheme: .bearer.,\s*type: .http.\s*\}),\s*\{\s*scheme: .bearer.,\s*type: .http.\s*\}/$$1/g' @blaxel/core/src/client/sdk.gen.ts
	sed -i.bak 's/\([A-Za-z_][A-Za-z0-9_]*\)Readable/\1/g' @blaxel/core/src/client/types.gen.ts
	sed -i.bak 's/TimeFieldsWritable/TimeFields/g' @blaxel/core/src/client/types.gen.ts
	sed -i.bak 's/OwnerFieldsWritable/OwnerFields/g' @blaxel/core/src/client/types.gen.ts
	sed -i.bak 's/export type Function =/export type _Function =/g' @blaxel/core/src/client/types.gen.ts
	sed -i.bak 's/: Function;/: _Function;/g' @blaxel/core/src/client/types.gen.ts
	sed -i.bak 's/<Function>/<_Function>/g' @blaxel/core/src/client/types.gen.ts
	rm -f @blaxel/core/src/client/index.ts.bak
	rm -f @blaxel/core/src/client/sdk.gen.ts.bak
	rm -f @blaxel/core/src/client/types.gen.ts.bak
	rm -rf ./tmp
	rm definition.yml

sdk: sdk-sandbox sdk-controlplane

tag:
	git checkout main
	git pull origin main
	git tag -a v$(ARGS) -m "Release v$(ARGS)"
	git push origin v$(ARGS)

%:
	@:

.PHONY: sdk
