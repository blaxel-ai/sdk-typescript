sdk-uvm:
	cp ../uvm/uvm-api/docs/swagger.yaml ./swagger.yml
	rm -rf src/uvm/client/types.gen.ts src/uvm/client/sdk.gen.ts
	npx swagger2openapi --yaml --outfile ./definition.yml ./swagger.yml
	npx @hey-api/openapi-ts@0.61.0 -i ./definition.yml -o ./tmp/ -c @hey-api/client-fetch
	cp -r ./tmp/* ./src/uvm/client

	sed -i.bak 's/from '\''\.\/sdk\.gen'\''/from '\''\.\/sdk\.gen\.js'\''/g' src/uvm/client/index.ts
	sed -i.bak 's/from '\''\.\/types\.gen'\''/from '\''\.\/types\.gen\.js'\''/g' src/uvm/client/index.ts
	sed -i.bak 's/export type GetFilesystemByPathResponse = (Directory);/export type GetFilesystemByPathResponse = (Directory | FileWithContent);/g' src/uvm/client/types.gen.ts
	echo "\n\nexport type FileWithContent = File & { content?: string };" >> src/uvm/client/types.gen.ts
	rm -f src/uvm/client/index.ts.bak
	rm -f src/uvm/client/types.gen.ts.bak
	rm -f src/uvm/client/sdk.gen.ts.bak
	rm -rf ./tmp
	rm definition.yml
	rm swagger.yml

sdk-controlplane:
	cp ../controlplane/api/api/definitions/controlplane.yml ./definition.yml
	rm -rf src/client/types.gen.ts src/client/sdk.gen.ts
	npx @hey-api/openapi-ts@0.61.0 -i ./definition.yml -o ./tmp/ -c @hey-api/client-fetch
	cp -r ./tmp/* ./src/client

	sed -i.bak 's/from '\''\.\/sdk\.gen'\''/from '\''\.\/sdk\.gen\.js'\''/g' src/client/index.ts
	sed -i.bak 's/from '\''\.\/types\.gen'\''/from '\''\.\/types\.gen\.js'\''/g' src/client/index.ts
	sed -i.bak 's/from '\''\.\/types\.gen'\''/from '\''\.\/types\.gen\.js'\''/g' src/client/sdk.gen.ts
	rm -f src/client/index.ts.bak
	rm -f src/client/sdk.gen.ts.bak
	rm -rf ./tmp
	rm definition.yml

sdk: sdk-uvm sdk-controlplane