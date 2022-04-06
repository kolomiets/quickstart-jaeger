FROM python:3.8-buster

RUN apt install gcc
RUN pip3 install taskcat --upgrade

WORKDIR /src
ENTRYPOINT ["taskcat"]
CMD ["-h"]