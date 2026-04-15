IMAGE_NAME := sandbox-local

build:
	docker build -t $(IMAGE_NAME) .

run:
	docker rm -f $(IMAGE_NAME) || true
	docker run -p 8080:8080 --name $(IMAGE_NAME) $(IMAGE_NAME)